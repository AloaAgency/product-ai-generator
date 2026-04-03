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

async function fetchProductRecord(supabase: WorkerSupabase, productId: string): Promise<ProductRecord> {
  const { data, error } = await supabase
    .from(T.products)
    .select('project_id, global_style_settings')
    .eq('id', productId)
    .single()

  if (error || !data) {
    throw new Error(error?.message || 'Product not found for generation job')
  }

  return data as ProductRecord
}

async function fetchReferenceImages(
  supabase: WorkerSupabase,
  referenceSetId: string,
  context: string
): Promise<WorkerReferenceImage[]> {
  const { data, error } = await supabase
    .from(T.reference_images)
    .select(REFERENCE_IMAGE_SELECT)
    .eq('reference_set_id', referenceSetId)
    .order('display_order', { ascending: true })

  if (error) {
    throw new Error(`${context}: ${error.message}`)
  }

  return (data || []) as unknown as WorkerReferenceImage[]
}

async function fetchSourceImage(
  supabase: WorkerSupabase,
  sourceImageId: string | null | undefined
): Promise<SourceImageRecord | null> {
  if (!sourceImageId) return null

  const { data, error } = await supabase
    .from(T.generated_images)
    .select('storage_path, mime_type')
    .eq('id', sourceImageId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load source image: ${error.message}`)
  }

  return (data as SourceImageRecord | null) ?? null
}

async function resolveGeminiApiKeyForJob(
  supabase: WorkerSupabase,
  product: ProductRecord
): Promise<string | undefined> {
  const productKey = resolveGoogleApiKey(product.global_style_settings)
  if (productKey || !product.project_id) return productKey

  const { data: project, error } = await supabase
    .from(T.projects)
    .select('global_style_settings')
    .eq('id', product.project_id)
    .single()

  if (error) {
    throw new Error(`Failed to load project settings: ${error.message}`)
  }

  return resolveGoogleApiKey((project as ProjectRecord | null)?.global_style_settings)
}

function limitReferenceImages(
  images: WorkerReferenceImage[],
  limit: number | null | undefined
): WorkerReferenceImage[] {
  const maxImages = limit ?? images.length
  return images.slice(0, maxImages)
}

async function downloadStorageBase64(
  supabase: WorkerSupabase,
  bucket: string,
  storagePath: string,
  mimeType: string,
  context: string
): Promise<Base64ReferenceImage | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath)

  if (error) {
    throw new Error(`${context}: ${error.message}`)
  }

  if (!data) return null

  const arrayBuffer = await data.arrayBuffer()
  return {
    mimeType,
    base64: Buffer.from(arrayBuffer).toString('base64'),
  }
}

async function buildReferenceImagePayloads(
  supabase: WorkerSupabase,
  sourceImage: SourceImageRecord | null,
  referenceImages: WorkerReferenceImage[]
): Promise<Base64ReferenceImage[]> {
  const sourcePayload = sourceImage
    ? await downloadStorageBase64(
      supabase,
      'generated-images',
      sourceImage.storage_path,
      sourceImage.mime_type,
      'Failed to download source image'
    )
    : null

  const referencePayloads = await Promise.all(
    referenceImages.map((image) => downloadStorageBase64(
      supabase,
      'reference-images',
      image.storage_path,
      image.mime_type,
      'Failed to download reference image'
    ))
  )

  return [
    ...(sourcePayload ? [sourcePayload] : []),
    ...referencePayloads.filter((image): image is Base64ReferenceImage => image !== null),
  ]
}

async function loadImageJobResources(
  supabase: WorkerSupabase,
  job: GenerationJobRecord
): Promise<LoadedImageJobResources> {
  if (!job.reference_set_id) {
    throw new Error('Image generation job missing reference_set_id')
  }

  const [product, productReferenceImages, textureReferenceImages, sourceImage] = await Promise.all([
    fetchProductRecord(supabase, job.product_id),
    fetchReferenceImages(supabase, job.reference_set_id, 'Failed to load reference images'),
    job.texture_set_id
      ? fetchReferenceImages(supabase, job.texture_set_id, 'Failed to load texture reference images')
      : Promise.resolve([]),
    fetchSourceImage(supabase, job.source_image_id),
  ])

  const limitedReferenceImages = [
    ...limitReferenceImages(productReferenceImages, job.product_image_count),
    ...limitReferenceImages(textureReferenceImages, job.texture_image_count),
  ]

  return {
    geminiApiKey: await resolveGeminiApiKeyForJob(supabase, product),
    referenceImages: await buildReferenceImagePayloads(supabase, sourceImage, limitedReferenceImages),
  }
}

function createVariationPlan(job: GenerationJobRecord, batchSize: number): VariationPlan {
  const counts = getJobCounts(job)
  const remaining = job.variation_count - counts.completed - counts.failed
  const toProcess = Math.max(0, Math.min(batchSize, remaining))

  return {
    promptSlug: slugify(job.final_prompt, 30),
    startingCompleted: counts.completed,
    startingFailed: counts.failed,
    variationNumbers: Array.from(
      { length: toProcess },
      (_, index) => counts.completed + counts.failed + index + 1
    ),
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(ms: number) {
  return ms + Math.floor(Math.random() * 250)
}

function isRetriableError(err: unknown) {
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

async function persistProgress(
  supabase: WorkerSupabase,
  jobId: string,
  progress: ProgressState,
  plan: VariationPlan
) {
  await updateGenerationJob(
    supabase,
    jobId,
    {
      completed_count: plan.startingCompleted + progress.successCount,
      failed_count: plan.startingFailed + progress.failCount,
      ...(progress.lastError ? { error_message: progress.lastError } : {}),
    },
    {
      expectedStatuses: ['pending', 'running'],
      allowNoop: true,
      context: 'Failed to persist generation job progress',
    }
  )
}

async function runVariation(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  variationNumber: number,
  promptSlug: string,
  geminiApiKey: string | undefined,
  referenceImages: Base64ReferenceImage[],
  variationTimeoutMs: number
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), variationTimeoutMs)

  try {
    const result = await generateGeminiImage({
      prompt: job.final_prompt,
      resolution: job.resolution as '2K' | '4K',
      aspectRatio: job.aspect_ratio as '16:9' | '1:1' | '9:16',
      referenceImages,
      apiKey: geminiApiKey,
      signal: controller.signal,
    })

    const imageBuffer = Buffer.from(result.base64Data, 'base64')
    const extension = resolveExtension(result.mimeType)
    const thumbnail = await createThumbnail(imageBuffer)
    const preview = await createPreview(imageBuffer)

    const storagePath = buildImageStoragePath(job.product_id, job.id, variationNumber, promptSlug, extension)
    const thumbPath = buildThumbnailPath(storagePath, thumbnail.extension)
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
        .upload(thumbPath, thumbnail.buffer, { contentType: thumbnail.mimeType }),
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

async function runVariationWithRetry(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  variationNumber: number,
  promptSlug: string,
  resources: LoadedImageJobResources,
  config: WorkerConfig
) {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= config.maxVariationRetries; attempt += 1) {
    try {
      await runVariation(
        supabase,
        job,
        variationNumber,
        promptSlug,
        resources.geminiApiKey,
        resources.referenceImages,
        config.variationTimeoutMs
      )
      return
    } catch (err) {
      lastError = err
      if (attempt >= config.maxVariationRetries || !isRetriableError(err)) {
        throw err
      }
      await sleep(jitter(config.retryBaseMs * Math.pow(2, attempt)))
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Variation failed')
}

function createShouldStopChecker(
  supabase: WorkerSupabase,
  jobId: string,
  timeBudgetMs: number
) {
  const startedAt = Date.now()
  let cancelled = false
  let lastStatusCheckAt = 0

  const shouldStop = async () => {
    if (Date.now() - startedAt > timeBudgetMs) return true
    if (Date.now() - lastStatusCheckAt < STATUS_REFRESH_INTERVAL_MS) return cancelled

    lastStatusCheckAt = Date.now()
    const { data, error } = await supabase
      .from(T.generation_jobs)
      .select('status')
      .eq('id', jobId)
      .single()

    if (error) {
      throw new Error(`Failed to refresh generation job status: ${error.message}`)
    }

    cancelled = data?.status === 'cancelled'
    return cancelled
  }

  return {
    shouldStop,
    wasCancelled: () => cancelled,
  }
}

async function processVariations(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  plan: VariationPlan,
  resources: LoadedImageJobResources,
  config: WorkerConfig
): Promise<VariationProcessingResult> {
  const progress: ProgressState = {
    processed: 0,
    successCount: 0,
    failCount: 0,
    lastError: null,
  }

  let nextIndex = 0
  const stopChecker = createShouldStopChecker(supabase, job.id, config.timeBudgetMs)

  const worker = async () => {
    while (nextIndex < plan.variationNumbers.length) {
      if (await stopChecker.shouldStop()) {
        break
      }

      const variationNumber = plan.variationNumbers[nextIndex]
      nextIndex += 1

      try {
        await runVariationWithRetry(supabase, job, variationNumber, plan.promptSlug, resources, config)
        progress.successCount += 1
      } catch (err) {
        progress.failCount += 1
        progress.lastError = sanitizeWorkerErrorMessage(err, 'Variation failed')
      } finally {
        progress.processed += 1
        await persistProgress(supabase, job.id, progress, plan)
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(config.parallelism, plan.variationNumbers.length) },
      () => worker()
    )
  )

  return {
    processed: progress.processed,
    completedCount: plan.startingCompleted + progress.successCount,
    failedCount: plan.startingFailed + progress.failCount,
    lastError: progress.lastError,
    cancelled: stopChecker.wasCancelled(),
  }
}

async function persistFinalImageJobState(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  result: VariationProcessingResult
) {
  if (result.cancelled) {
    return createWorkerResult(
      job.id,
      'cancelled',
      { completed: result.completedCount, failed: result.failedCount },
      result.processed
    )
  }

  const finalCompleted = result.completedCount + result.failedCount >= job.variation_count
  const allFailed = finalCompleted && result.completedCount === 0 && result.failedCount > 0
  const finalStatus = finalCompleted
    ? allFailed ? 'failed' : 'completed'
    : 'pending'

  const updates: Record<string, unknown> = {
    completed_count: result.completedCount,
    failed_count: result.failedCount,
    status: finalStatus,
    ...(result.lastError ? { error_message: result.lastError } : {}),
  }

  if (finalCompleted) {
    updates.completed_at = new Date().toISOString()
    if (allFailed) {
      updates.error_message = result.lastError || 'All variations failed'
    }
  }

  await updateGenerationJob(
    supabase,
    job.id,
    updates,
    {
      expectedStatuses: ['pending', 'running'],
      allowNoop: false,
      context: 'Failed to persist final generation job state',
    }
  )

  return createWorkerResult(
    job.id,
    finalStatus,
    { completed: result.completedCount, failed: result.failedCount },
    result.processed
  )
}

export async function processGenerationJob(jobId: string, options: WorkerOptions = {}): Promise<WorkerResult> {
  if (!isValidGenerationJobId(jobId)) {
    throw new Error('Invalid generation job id')
  }

  const supabase = createServiceClient()
  const config = parseWorkerConfig(options)
  const initialJob = await loadGenerationJob(supabase, jobId)
  const earlyResult = await maybeReturnNonPendingJob(initialJob)

  if (earlyResult) {
    return earlyResult
  }

  const claimedJob = await claimPendingJob(supabase, initialJob)
  if (!claimedJob) {
    return getLatestJobResult(supabase, jobId)
  }

  try {
    if (normalizeJobType(claimedJob) === 'video') {
      return processVideoJob(claimedJob, supabase)
    }

    const resources = await loadImageJobResources(supabase, claimedJob)
    const plan = createVariationPlan(claimedJob, config.batchSize)
    const variationResult = await processVariations(supabase, claimedJob, plan, resources, config)
    return persistFinalImageJobState(supabase, claimedJob, variationResult)
  } catch (err) {
    const safeMessage = sanitizeWorkerErrorMessage(err, 'Generation job failed')
    await markClaimedJobFailed(supabase, claimedJob, safeMessage)
    throw err
  }
}
