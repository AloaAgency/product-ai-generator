import { createServiceClient } from '@/lib/supabase/server'
import { generateGeminiImage } from '@/lib/gemini'
import { generateSceneVideo } from '@/lib/video-generation'
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
import type { GlobalStyleSettings, ReferenceImage } from '@/lib/types'
import { resolveGoogleApiKey } from '@/lib/google-api-keys'
import {
  isValidGenerationJobId,
  MAX_GENERATION_BATCH_SIZE,
  MAX_GENERATION_PARALLELISM,
  parseWorkerPositiveInteger,
  sanitizeWorkerErrorMessage,
} from '@/lib/generation-worker-guards'

type WorkerSupabase = ReturnType<typeof createServiceClient>

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

type GenerationJobRecord = {
  id: string
  product_id: string
  prompt_template_id: string | null
  reference_set_id: string | null
  texture_set_id: string | null
  product_image_count: number | null
  texture_image_count: number | null
  final_prompt: string
  variation_count: number
  resolution: string
  aspect_ratio: string
  status: string
  completed_count: number | null
  failed_count: number | null
  error_message: string | null
  generation_model: string | null
  job_type?: 'image' | 'video' | null
  scene_id?: string | null
  source_image_id?: string | null
}

type WorkerReferenceImage = Pick<ReferenceImage, 'id' | 'reference_set_id' | 'storage_path' | 'mime_type' | 'display_order'>
type GenerationJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
type Base64ReferenceImage = { mimeType: string; base64: string }

type WorkerConfig = {
  batchSize: number
  parallelism: number
  timeBudgetMs: number
  variationTimeoutMs: number
  maxVariationRetries: number
  retryBaseMs: number
}

type JobCounts = {
  completed: number
  failed: number
}

type ProductRecord = {
  project_id: string | null
  global_style_settings: GlobalStyleSettings | null
}

type ProjectRecord = {
  global_style_settings: GlobalStyleSettings | null
}

type SourceImageRecord = {
  storage_path: string
  mime_type: string
}

type LoadedImageJobResources = {
  geminiApiKey?: string
  referenceImages: Base64ReferenceImage[]
}

type VariationPlan = {
  promptSlug: string
  startingCompleted: number
  startingFailed: number
  variationNumbers: number[]
}

type ProgressState = {
  processed: number
  successCount: number
  failCount: number
  lastError: string | null
}

type VariationProcessingResult = {
  processed: number
  completedCount: number
  failedCount: number
  lastError: string | null
  cancelled: boolean
}

const DEFAULT_TIME_BUDGET_MS = 760000
const MAX_TIME_BUDGET_MS = 800000
const DEFAULT_VARIATION_TIMEOUT_MS = 300000
const DEFAULT_VARIATION_RETRIES = 2
const DEFAULT_RETRY_BASE_MS = 1500
const STATUS_REFRESH_INTERVAL_MS = 3000

const GENERATION_JOB_SELECT = [
  'id',
  'product_id',
  'prompt_template_id',
  'reference_set_id',
  'texture_set_id',
  'product_image_count',
  'texture_image_count',
  'final_prompt',
  'variation_count',
  'resolution',
  'aspect_ratio',
  'status',
  'completed_count',
  'failed_count',
  'error_message',
  'generation_model',
  'job_type',
  'scene_id',
  'source_image_id',
].join(', ')

const REFERENCE_IMAGE_SELECT = [
  'id',
  'reference_set_id',
  'storage_path',
  'mime_type',
  'display_order',
].join(', ')

const normalizeJobType = (job: GenerationJobRecord) => (job.job_type === 'video' ? 'video' : 'image')

function getJobCounts(job: Pick<GenerationJobRecord, 'completed_count' | 'failed_count'>): JobCounts {
  return {
    completed: job.completed_count || 0,
    failed: job.failed_count || 0,
  }
}

function createWorkerResult(
  jobId: string,
  status: string,
  counts: JobCounts,
  processed = 0
): WorkerResult {
  return {
    jobId,
    processed,
    completed: counts.completed,
    failed: counts.failed,
    status,
  }
}

function parseWorkerConfig(options: WorkerOptions): WorkerConfig {
  const variationTimeoutMsRaw = Number(process.env.GENERATION_VARIATION_TIMEOUT_MS)
  const maxVariationRetriesRaw = Number(process.env.GENERATION_VARIATION_RETRIES)
  const retryBaseMsRaw = Number(process.env.GENERATION_RETRY_BASE_MS)

  return {
    batchSize: parseWorkerPositiveInteger(options.batchSize, 1, { max: MAX_GENERATION_BATCH_SIZE }),
    parallelism: parseWorkerPositiveInteger(options.parallelism, 1, { max: MAX_GENERATION_PARALLELISM }),
    timeBudgetMs: parseWorkerPositiveInteger(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, { max: MAX_TIME_BUDGET_MS }),
    variationTimeoutMs: Number.isFinite(variationTimeoutMsRaw) && variationTimeoutMsRaw > 0
      ? variationTimeoutMsRaw
      : DEFAULT_VARIATION_TIMEOUT_MS,
    maxVariationRetries: Number.isFinite(maxVariationRetriesRaw) && maxVariationRetriesRaw >= 0
      ? maxVariationRetriesRaw
      : DEFAULT_VARIATION_RETRIES,
    retryBaseMs: Number.isFinite(retryBaseMsRaw) && retryBaseMsRaw > 0
      ? retryBaseMsRaw
      : DEFAULT_RETRY_BASE_MS,
  }
}

async function updateGenerationJob(
  supabase: WorkerSupabase,
  jobId: string,
  updates: Record<string, unknown>,
  options: {
    expectedStatuses?: GenerationJobStatus[]
    allowNoop?: boolean
    context: string
  }
) {
  let query = supabase
    .from(T.generation_jobs)
    .update(updates)
    .eq('id', jobId)

  if (options.expectedStatuses?.length) {
    query = options.expectedStatuses.length === 1
      ? query.eq('status', options.expectedStatuses[0])
      : query.in('status', options.expectedStatuses)
  }

  const { data, error } = await query
    .select('id')
    .maybeSingle()

  if (error) {
    throw new Error(`${options.context}: ${error.message}`)
  }

  if (!data && !options.allowNoop) {
    throw new Error(`${options.context}: job state changed before update could be applied`)
  }
}

async function markClaimedJobFailed(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  message: string
) {
  await updateGenerationJob(
    supabase,
    job.id,
    {
      failed_count: getJobCounts(job).failed + 1,
      status: 'failed',
      error_message: message,
      completed_at: new Date().toISOString(),
    },
    {
      expectedStatuses: ['running'],
      allowNoop: true,
      context: 'Failed to mark generation job as failed',
    }
  )
}

async function loadGenerationJob(supabase: WorkerSupabase, jobId: string): Promise<GenerationJobRecord> {
  const { data, error } = await supabase
    .from(T.generation_jobs)
    .select(GENERATION_JOB_SELECT)
    .eq('id', jobId)
    .single()

  if (error || !data) {
    throw new Error('Generation job not found')
  }

  return data as unknown as GenerationJobRecord
}

async function getLatestJobResult(supabase: WorkerSupabase, jobId: string): Promise<WorkerResult> {
  const { data } = await supabase
    .from(T.generation_jobs)
    .select('status, completed_count, failed_count')
    .eq('id', jobId)
    .single()

  const counts = getJobCounts({
    completed_count: data?.completed_count ?? 0,
    failed_count: data?.failed_count ?? 0,
  })

  return createWorkerResult(jobId, data?.status || 'running', counts)
}

async function claimPendingJob(supabase: WorkerSupabase, job: GenerationJobRecord): Promise<GenerationJobRecord | null> {
  const { data, error } = await supabase
    .from(T.generation_jobs)
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select(GENERATION_JOB_SELECT)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to claim generation job: ${error.message}`)
  }

  return (data as unknown as GenerationJobRecord | null) ?? null
}

async function maybeReturnNonPendingJob(job: GenerationJobRecord): Promise<WorkerResult | null> {
  if (job.status === 'pending') return null
  return createWorkerResult(job.id, job.status, getJobCounts(job))
}

async function processVideoJob(
  job: GenerationJobRecord,
  supabase: WorkerSupabase
): Promise<WorkerResult> {
  const counts = getJobCounts(job)

  if (job.status === 'completed' || job.status === 'cancelled') {
    return createWorkerResult(job.id, job.status, counts)
  }

  if (job.status === 'pending') {
    await updateGenerationJob(
      supabase,
      job.id,
      { status: 'running', started_at: new Date().toISOString() },
      {
        expectedStatuses: ['pending', 'running'],
        context: 'Failed to start video generation job',
      }
    )
  }

  if (!job.scene_id) {
    const failedCounts = { ...counts, failed: counts.failed + 1 }
    await updateGenerationJob(
      supabase,
      job.id,
      {
        status: 'failed',
        failed_count: failedCounts.failed,
        error_message: 'Video job missing scene_id',
        completed_at: new Date().toISOString(),
      },
      {
        expectedStatuses: ['pending', 'running'],
        context: 'Failed to persist missing scene_id failure',
      }
    )
    return createWorkerResult(job.id, 'failed', failedCounts, 1)
  }

  try {
    await generateSceneVideo(job.product_id, job.scene_id, job.generation_model || undefined, job.id)
    const completedCounts = { ...counts, completed: counts.completed + 1 }
    await updateGenerationJob(
      supabase,
      job.id,
      {
        completed_count: completedCounts.completed,
        status: 'completed',
        completed_at: new Date().toISOString(),
      },
      {
        expectedStatuses: ['pending', 'running'],
        context: 'Failed to persist completed video generation job',
      }
    )
    return createWorkerResult(job.id, 'completed', completedCounts, 1)
  } catch (err) {
    const failedCounts = { ...counts, failed: counts.failed + 1 }
    await updateGenerationJob(
      supabase,
      job.id,
      {
        failed_count: failedCounts.failed,
        status: 'failed',
        error_message: sanitizeWorkerErrorMessage(err, 'Video generation failed'),
        completed_at: new Date().toISOString(),
      },
      {
        expectedStatuses: ['pending', 'running'],
        context: 'Failed to persist video generation failure',
      }
    )
    return createWorkerResult(job.id, 'failed', failedCounts, 1)
  }
}

export async function processGenerationJob(jobId: string, options: WorkerOptions = {}): Promise<WorkerResult> {
  if (!isValidGenerationJobId(jobId)) {
    throw new Error('Invalid generation job id')
  }

  const supabase = createServiceClient()
  const batchSize = parseWorkerPositiveInteger(options.batchSize, 1, { max: MAX_GENERATION_BATCH_SIZE })
  const parallelism = parseWorkerPositiveInteger(options.parallelism, 1, { max: MAX_GENERATION_PARALLELISM })
  const timeBudgetMs = parseWorkerPositiveInteger(options.timeBudgetMs, 760000, { max: 800000 })
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

  const { data: initialJob, error: jobError } = await supabase
    .from(T.generation_jobs)
    .select(GENERATION_JOB_SELECT)
    .eq('id', jobId)
    .single()

  if (jobError || !initialJob) {
    throw new Error('Generation job not found')
  }

  let job = initialJob as unknown as GenerationJobRecord

  if (job.status === 'completed' || job.status === 'cancelled') {
    return {
      jobId,
      processed: 0,
      completed: job.completed_count || 0,
      failed: job.failed_count || 0,
      status: job.status,
    }
  }

  // Only one worker should claim a pending job. Running jobs are already owned by another worker.
  if (job.status === 'running') {
    return {
      jobId,
      processed: 0,
      completed: job.completed_count || 0,
      failed: job.failed_count || 0,
      status: job.status,
    }
  }

  if (job.status !== 'pending') {
    return {
      jobId,
      processed: 0,
      completed: job.completed_count || 0,
      failed: job.failed_count || 0,
      status: job.status,
    }
  }

  const { data: claimedJob, error: claimError } = await supabase
    .from(T.generation_jobs)
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select(GENERATION_JOB_SELECT)
    .maybeSingle()

  if (claimError) {
    throw new Error(`Failed to claim generation job: ${claimError.message}`)
  }

  if (!claimedJob) {
    const { data: latestJob } = await supabase
      .from(T.generation_jobs)
      .select('status, completed_count, failed_count')
      .eq('id', job.id)
      .single()

    return {
      jobId,
      processed: 0,
      completed: latestJob?.completed_count || 0,
      failed: latestJob?.failed_count || 0,
      status: latestJob?.status || 'running',
    }
  }

  job = claimedJob as unknown as GenerationJobRecord

  try {
    const jobType = normalizeJobType(job)
    if (jobType === 'video') {
      return processVideoJob(job, supabase)
    }

    if (!job.reference_set_id) {
      throw new Error('Image generation job missing reference_set_id')
    }

    const productPromise = supabase
      .from(T.products)
      .select('project_id, global_style_settings')
      .eq('id', job.product_id)
      .single()

    const productReferenceImagesPromise = supabase
      .from(T.reference_images)
      .select(REFERENCE_IMAGE_SELECT)
      .eq('reference_set_id', job.reference_set_id)
      .order('display_order', { ascending: true })

    const textureReferenceImagesPromise = job.texture_set_id
      ? supabase
        .from(T.reference_images)
        .select(REFERENCE_IMAGE_SELECT)
        .eq('reference_set_id', job.texture_set_id)
        .order('display_order', { ascending: true })
      : Promise.resolve({ data: null, error: null })

    const sourceImagePromise = job.source_image_id
      ? supabase
        .from(T.generated_images)
        .select('storage_path, mime_type')
        .eq('id', job.source_image_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null })

    const [
      { data: product, error: productError },
      { data: refImages, error: refImagesError },
      { data: texImages, error: textureImagesError },
      { data: sourceImg, error: sourceImageError },
    ] = await Promise.all([
      productPromise,
      productReferenceImagesPromise,
      textureReferenceImagesPromise,
      sourceImagePromise,
    ])

    if (productError || !product) {
      throw new Error(productError?.message || 'Product not found for generation job')
    }

    if (refImagesError) {
      throw new Error(`Failed to load reference images: ${refImagesError.message}`)
    }

    if (textureImagesError) {
      throw new Error(`Failed to load texture reference images: ${textureImagesError.message}`)
    }

    if (sourceImageError) {
      throw new Error(`Failed to load source image: ${sourceImageError.message}`)
    }

    let geminiApiKey = resolveGoogleApiKey(product.global_style_settings as GlobalStyleSettings | null)

    if (!geminiApiKey && product.project_id) {
      const { data: project, error: projectError } = await supabase
        .from(T.projects)
        .select('global_style_settings')
        .eq('id', product.project_id)
        .single()
      if (projectError) {
        throw new Error(`Failed to load project settings: ${projectError.message}`)
      }
      geminiApiKey = resolveGoogleApiKey(project?.global_style_settings as GlobalStyleSettings | null)
    }

  const referenceImages = (refImages || []) as unknown as WorkerReferenceImage[]
  const productImageLimit = job.product_image_count ?? referenceImages.length
  const limitedProductImages = referenceImages.slice(0, productImageLimit)

  let textureImages: WorkerReferenceImage[] = []
  if (job.texture_set_id && texImages) {
    textureImages = (texImages || []) as unknown as WorkerReferenceImage[]
    const textureImageLimit = job.texture_image_count ?? textureImages.length
    textureImages = textureImages.slice(0, textureImageLimit)
  }

  // Combine product images first, then texture images
  const allReferenceImages = [...limitedProductImages, ...textureImages]
  const refImagesBase64: { mimeType: string; base64: string }[] = []

    if (sourceImg) {
      const { data: sourceFileData, error: sourceDownloadError } = await supabase.storage
        .from('generated-images')
        .download(sourceImg.storage_path)
      if (sourceDownloadError) {
        throw new Error(`Failed to download source image: ${sourceDownloadError.message}`)
      }
      if (sourceFileData) {
        const arrayBuffer = await sourceFileData.arrayBuffer()
        const base64 = Buffer.from(arrayBuffer).toString('base64')
        refImagesBase64.push({ mimeType: sourceImg.mime_type, base64 })
      }
    }

    const downloadedReferenceImages = await Promise.all(
      allReferenceImages.map(async (refImg) => {
        const { data: fileData, error: fileError } = await supabase.storage
          .from('reference-images')
          .download(refImg.storage_path)
        if (fileError) {
          throw new Error(`Failed to download reference image: ${fileError.message}`)
        }
        if (!fileData) return null
        const arrayBuffer = await fileData.arrayBuffer()
        return {
          mimeType: refImg.mime_type,
          base64: Buffer.from(arrayBuffer).toString('base64'),
        }
      })
    )
    refImagesBase64.push(
      ...downloadedReferenceImages.filter(
        (image): image is { mimeType: string; base64: string } => image !== null
      )
    )

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
        apiKey: geminiApiKey,
        signal: controller.signal,
      })

      const imageBuffer = Buffer.from(result.base64Data, 'base64')
      const ext = resolveExtension(result.mimeType)

      const thumb = await createThumbnail(imageBuffer)
      const preview = await createPreview(imageBuffer)

      const storagePath = buildImageStoragePath(job.product_id, job.id, variationNumber, promptSlug, ext)
      const thumbPath = buildThumbnailPath(storagePath, thumb.extension)
      const previewPath = buildPreviewPath(storagePath, preview.extension)

      const [
        { error: imageUploadError },
        { error: thumbUploadError },
        { error: previewUploadError },
      ] = await Promise.all([
        supabase.storage
          .from('generated-images')
          .upload(storagePath, imageBuffer, { contentType: result.mimeType }),
        supabase.storage
          .from('generated-images')
          .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType }),
        supabase.storage
          .from('generated-images')
          .upload(previewPath, preview.buffer, { contentType: preview.mimeType }),
      ])

      if (imageUploadError) {
        throw new Error(`Failed to upload generated image: ${imageUploadError.message}`)
      }
      if (thumbUploadError) {
        throw new Error(`Failed to upload image thumbnail: ${thumbUploadError.message}`)
      }
      if (previewUploadError) {
        throw new Error(`Failed to upload image preview: ${previewUploadError.message}`)
      }

      const { error: insertError } = await supabase.from(T.generated_images).insert({
        job_id: job.id,
        variation_number: variationNumber,
        storage_path: storagePath,
        thumb_storage_path: thumbPath,
        preview_storage_path: previewPath,
        mime_type: result.mimeType,
        file_size: imageBuffer.length,
        approval_status: 'pending',
      })

      if (insertError) {
        throw new Error(`Failed to record generated image: ${insertError.message}`)
      }
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
    const { data, error: statusError } = await supabase
      .from(T.generation_jobs)
      .select('status')
      .eq('id', job.id)
      .single()
    if (statusError) {
      throw new Error(`Failed to refresh generation job status: ${statusError.message}`)
    }
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
        lastError = sanitizeWorkerErrorMessage(err, 'Variation failed')
      } finally {
        processed += 1
        // Incremental progress update so polling clients see real progress.
        await updateGenerationJob(
          supabase,
          job.id,
          {
            completed_count: startingCompleted + successCount,
            failed_count: startingFailed + failCount,
            ...(lastError ? { error_message: lastError } : {}),
          },
          {
            expectedStatuses: ['pending', 'running'],
            allowNoop: true,
            context: 'Failed to persist generation job progress',
          }
        )
      }
    }
  }

  const workers = Array.from({ length: Math.min(parallelism, variationNumbers.length) }, () => worker())
  await Promise.all(workers)

  const completedCount = startingCompleted + successCount
  const failedCount = startingFailed + failCount

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
  const allFailed = finalCompleted && completedCount === 0 && failedCount > 0
  const finalStatus = finalCompleted
    ? allFailed ? 'failed' : 'completed'
    : 'pending'
  const failureMessage = lastError || 'All variations failed'
  const updates: Record<string, unknown> = {
    completed_count: completedCount,
    failed_count: failedCount,
    status: finalStatus,
    ...(lastError ? { error_message: lastError } : {}),
  }

  if (finalCompleted) {
    updates.completed_at = new Date().toISOString()
    if (allFailed) updates.error_message = failureMessage
  }

    await updateGenerationJob(
      supabase,
      job.id,
      updates,
      {
        expectedStatuses: ['pending', 'running'],
        allowNoop: cancelled,
        context: 'Failed to persist final generation job state',
      }
    )

    return {
      jobId,
      processed,
      completed: completedCount,
      failed: failedCount,
      status: finalStatus,
    }
  } catch (err) {
    const safeMessage = sanitizeWorkerErrorMessage(err, 'Generation job failed')
    await markClaimedJobFailed(supabase, job, safeMessage)
    throw err
  }
}
