import { createServiceClient } from '@/lib/supabase/server'
import { generateGeminiImage } from '@/lib/gemini'
import {
  buildImageStoragePath,
  buildPreviewPath,
  buildThumbnailPath,
  createPreview,
  createThumbnail,
  resolveExtension,
  slugify,
} from '@/lib/image-utils'
import { T } from '@/lib/db-tables'
import type { ReferenceImage } from '@/lib/types'

type WorkerResult = {
  jobId: string
  processed: number
  completed: number
  failed: number
  status: string
}

type WorkerOptions = {
  batchSize?: number
  parallelism?: number
  timeBudgetMs?: number
}

export async function processGenerationJob(jobId: string, options: WorkerOptions = {}): Promise<WorkerResult> {
  const supabase = createServiceClient()
  const batchSize = Number.isFinite(options.batchSize) && (options.batchSize as number) > 0
    ? (options.batchSize as number)
    : 1
  const parallelism = Number.isFinite(options.parallelism) && (options.parallelism as number) > 0
    ? (options.parallelism as number)
    : 1
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs) && (options.timeBudgetMs as number) > 0
    ? (options.timeBudgetMs as number)
    : 760000
  const variationTimeoutMsRaw = Number(process.env.GENERATION_VARIATION_TIMEOUT_MS)
  const variationTimeoutMs = Number.isFinite(variationTimeoutMsRaw) && variationTimeoutMsRaw > 0
    ? variationTimeoutMsRaw
    : 300000
  const maxVariationRetriesRaw = Number(process.env.GENERATION_VARIATION_RETRIES)
  const maxVariationRetries = Number.isFinite(maxVariationRetriesRaw) && maxVariationRetriesRaw >= 0
    ? maxVariationRetriesRaw
    : 2
  const retryBaseMsRaw = Number(process.env.GENERATION_RETRY_BASE_MS)
  const retryBaseMs = Number.isFinite(retryBaseMsRaw) && retryBaseMsRaw > 0
    ? retryBaseMsRaw
    : 1500

  const { data: job, error: jobError } = await supabase
    .from(T.generation_jobs)
    .select('*')
    .eq('id', jobId)
    .single()

  if (jobError || !job) {
    throw new Error('Generation job not found')
  }

  if (job.status === 'completed' || job.status === 'cancelled') {
    return {
      jobId,
      processed: 0,
      completed: job.completed_count || 0,
      failed: job.failed_count || 0,
      status: job.status,
    }
  }

  if (job.status === 'pending') {
    await supabase
      .from(T.generation_jobs)
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .in('status', ['pending', 'running'])
  }

  const { data: refImages } = await supabase
    .from(T.reference_images)
    .select('*')
    .eq('reference_set_id', job.reference_set_id)
    .order('display_order', { ascending: true })

  const referenceImages: ReferenceImage[] = refImages || []
  const refImagesBase64: { mimeType: string; base64: string }[] = []

  for (const refImg of referenceImages) {
    const { data: fileData } = await supabase.storage
      .from('reference-images')
      .download(refImg.storage_path)
    if (!fileData) continue
    const arrayBuffer = await fileData.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    refImagesBase64.push({ mimeType: refImg.mime_type, base64 })
  }

  const promptSlug = slugify(job.final_prompt, 30)
  const startingCompleted = job.completed_count || 0
  const startingFailed = job.failed_count || 0
  const remaining = job.variation_count - startingCompleted - startingFailed
  const toProcess = Math.max(0, Math.min(batchSize, remaining))
  const variationNumbers = Array.from({ length: toProcess }, (_, i) => startingCompleted + startingFailed + i + 1)

  let processed = 0
  let successCount = 0
  let failCount = 0
  let lastError: string | null = null

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const jitter = (ms: number) => ms + Math.floor(Math.random() * 250)
  const isRetriableError = (err: unknown) => {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    return (
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('timeout') ||
      message.includes('aborted') ||
      message.includes('abort') ||
      message.includes('server error') ||
      message.includes('503') ||
      message.includes('502')
    )
  }

  const runVariation = async (variationNumber: number) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), variationTimeoutMs)
    try {
      const result = await generateGeminiImage({
        prompt: job.final_prompt,
        resolution: job.resolution as '2K' | '4K',
        aspectRatio: job.aspect_ratio as '16:9' | '1:1' | '9:16',
        referenceImages: refImagesBase64,
        signal: controller.signal,
      })

      const imageBuffer = Buffer.from(result.base64Data, 'base64')
      const ext = resolveExtension(result.mimeType)

      const thumb = await createThumbnail(imageBuffer)
      const preview = await createPreview(imageBuffer)

      const storagePath = buildImageStoragePath(job.product_id, job.id, variationNumber, promptSlug, ext)
      const thumbPath = buildThumbnailPath(storagePath, thumb.extension)
      const previewPath = buildPreviewPath(storagePath, preview.extension)

      await supabase.storage
        .from('generated-images')
        .upload(storagePath, imageBuffer, { contentType: result.mimeType })
      await supabase.storage
        .from('generated-images')
        .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })
      await supabase.storage
        .from('generated-images')
        .upload(previewPath, preview.buffer, { contentType: preview.mimeType })

      await supabase.from(T.generated_images).insert({
        job_id: job.id,
        variation_number: variationNumber,
        storage_path: storagePath,
        thumb_storage_path: thumbPath,
        preview_storage_path: previewPath,
        mime_type: result.mimeType,
        file_size: imageBuffer.length,
        approval_status: 'pending',
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const runVariationWithRetry = async (variationNumber: number) => {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= maxVariationRetries; attempt++) {
      try {
        await runVariation(variationNumber)
        return
      } catch (err) {
        lastError = err
        if (attempt >= maxVariationRetries || !isRetriableError(err)) {
          throw err
        }
        const delay = jitter(retryBaseMs * Math.pow(2, attempt))
        await sleep(delay)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Variation failed')
  }

  let index = 0
  const startedAt = Date.now()
  let cancelled = false
  let lastStatusCheck = 0
  const shouldStop = async () => {
    if (Date.now() - startedAt > timeBudgetMs) return true
    if (Date.now() - lastStatusCheck < 3000) return cancelled
    lastStatusCheck = Date.now()
    const { data } = await supabase
      .from(T.generation_jobs)
      .select('status')
      .eq('id', job.id)
      .single()
    if (data?.status === 'cancelled') {
      cancelled = true
      return true
    }
    return false
  }
  const worker = async () => {
    while (index < variationNumbers.length) {
      if (await shouldStop()) {
        break
      }
      const current = variationNumbers[index]
      index += 1
      try {
        await runVariationWithRetry(current)
        successCount += 1
      } catch (err) {
        failCount += 1
        lastError = err instanceof Error ? err.message : 'Variation failed'
      } finally {
        processed += 1
      }
    }
  }

  const workers = Array.from({ length: Math.min(parallelism, variationNumbers.length) }, () => worker())
  await Promise.all(workers)

  const completedCount = startingCompleted + successCount
  const failedCount = startingFailed + failCount

  await supabase
    .from(T.generation_jobs)
    .update({
      completed_count: completedCount,
      failed_count: failedCount,
      status: 'running',
      ...(lastError ? { error_message: lastError } : {}),
    })
    .eq('id', job.id)
    .in('status', ['pending', 'running'])

  if (cancelled) {
    return {
      jobId,
      processed,
      completed: completedCount,
      failed: failedCount,
      status: 'cancelled',
    }
  }

  const finalCompleted = completedCount + failedCount >= job.variation_count
  if (finalCompleted) {
    await supabase
      .from(T.generation_jobs)
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', job.id)
      .in('status', ['pending', 'running'])
    return {
      jobId,
      processed,
      completed: completedCount,
      failed: failedCount,
      status: 'completed',
    }
  }

  return {
    jobId,
    processed,
    completed: completedCount,
    failed: failedCount,
    status: 'running',
  }
}
