import { createServiceClient } from '@/lib/supabase/server'
import { generateGeminiImage } from '@/lib/gemini'
import { generateSceneVideo, VideoJobCancelledError } from '@/lib/video-generation'
import {
  buildImageStoragePath,
  buildPreviewPath,
  buildThumbnailPath,
  createThumbnailAndPreview,
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
import { createLogger } from '@/lib/logger'

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

type JobReferenceSetRow = {
  reference_set_id: string
  role: 'subject' | 'texture'
  display_order: number
  image_count: number | null
  selected_image_ids: string[] | null
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
  statusRefreshIntervalMs: number
}

type JobCounts = {
  completed: number
  failed: number
}

type ProjectSettingsRecord = {
  global_style_settings: GlobalStyleSettings | null
}

type ProductRecord = {
  global_style_settings: GlobalStyleSettings | null
  // PostgREST returns an object for this many-to-one embed, but older mocks
  // (and defensive callers) may still hand us an array.
  prodai_projects: ProjectSettingsRecord | ProjectSettingsRecord[] | null
}

type SourceImageRecord = {
  storage_path: string
  mime_type: string
}

type RecordedVariationRow = {
  variation_number: number | null
}
type SupabaseErrorLike = {
  code?: string
  message?: string
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

type ProgressSnapshot = Omit<ProgressState, 'processed'>

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
const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 3000
const log = createLogger('GenerationWorker')

const GENERATION_JOB_SELECT = [
  'id',
  'product_id',
  'prompt_template_id',
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
  const statusRefreshIntervalMsRaw = Number(process.env.GENERATION_STATUS_REFRESH_INTERVAL_MS)

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
    statusRefreshIntervalMs: Number.isFinite(statusRefreshIntervalMsRaw) && statusRefreshIntervalMsRaw > 0
      ? statusRefreshIntervalMsRaw
      : DEFAULT_STATUS_REFRESH_INTERVAL_MS,
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

  return data !== null
}

async function resolveTerminalUpdateConflict(
  supabase: WorkerSupabase,
  jobId: string,
  processed: number,
  context: string
): Promise<WorkerResult> {
  const latest = await getLatestJobResult(supabase, jobId)
  if (latest.status === 'cancelled') {
    return { ...latest, processed }
  }

  throw new Error(`${context}: job state changed before update could be applied`)
}

async function markClaimedJobFailed(
  supabase: WorkerSupabase,
  job: GenerationJobRecord,
  message: string
) {
  const { completed, failed } = await getCurrentJobCounts(supabase, job)

  await updateGenerationJob(
    supabase,
    job.id,
    {
      completed_count: completed,
      failed_count: failed + 1,
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

async function claimPendingJobById(
  supabase: WorkerSupabase,
  jobId: string
): Promise<GenerationJobRecord | null> {
  const { data, error } = await supabase
    .from(T.generation_jobs)
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select(GENERATION_JOB_SELECT)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to claim generation job: ${error.message}`)
  }

  return (data as unknown as GenerationJobRecord | null) ?? null
}

async function getLatestJobResult(supabase: WorkerSupabase, jobId: string): Promise<WorkerResult> {
  const { data, error } = await supabase
    .from(T.generation_jobs)
    .select('status, completed_count, failed_count')
    .eq('id', jobId)
    .single()

  if (error || !data) {
    throw new Error(`Failed to load latest generation job state: ${error?.message || 'job not found'}`)
  }

  const counts = getJobCounts({
    completed_count: data?.completed_count ?? 0,
    failed_count: data?.failed_count ?? 0,
  })

  return createWorkerResult(jobId, data?.status || 'running', counts)
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
    const updated = await updateGenerationJob(
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
        allowNoop: true,
        context: 'Failed to persist missing scene_id failure',
      }
    )
    if (!updated) {
      return resolveTerminalUpdateConflict(
        supabase,
        job.id,
        1,
        'Failed to persist missing scene_id failure'
      )
    }
    return createWorkerResult(job.id, 'failed', failedCounts, 1)
  }

  try {
    await generateSceneVideo(job.product_id, job.scene_id, job.generation_model || undefined, job.id)
  } catch (err) {
    if (err instanceof VideoJobCancelledError) {
      // The cancel endpoint already set status='cancelled'; recording this as
      // a failure would overwrite the user's cancellation.
      return createWorkerResult(job.id, 'cancelled', counts)
    }
    const failedCounts = { ...counts, failed: counts.failed + 1 }
    const updated = await updateGenerationJob(
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
        allowNoop: true,
        context: 'Failed to persist video generation failure',
      }
    )
    if (!updated) {
      return resolveTerminalUpdateConflict(
        supabase,
        job.id,
        1,
        'Failed to persist video generation failure'
      )
    }
    return createWorkerResult(job.id, 'failed', failedCounts, 1)
  }

  const completedCounts = { ...counts, completed: counts.completed + 1 }
  const updated = await updateGenerationJob(
    supabase,
    job.id,
    {
      completed_count: completedCounts.completed,
      status: 'completed',
      error_message: null,
      completed_at: new Date().toISOString(),
    },
    {
      expectedStatuses: ['pending', 'running'],
      allowNoop: true,
      context: 'Failed to persist completed video generation job',
    }
  )
  if (!updated) {
    return resolveTerminalUpdateConflict(
      supabase,
      job.id,
      1,
      'Failed to persist completed video generation job'
    )
  }
  return createWorkerResult(job.id, 'completed', completedCounts, 1)
}

async function fetchProductRecord(supabase: WorkerSupabase, productId: string): Promise<ProductRecord> {
  const { data, error } = await supabase
    .from(T.products)
    .select(`global_style_settings, ${T.projects}!fk_products_project(global_style_settings)`)
    .eq('id', productId)
    .single()

  if (error || !data) {
    throw new Error(error?.message || 'Product not found for generation job')
  }

  return data as ProductRecord
}

async function fetchJobReferenceSetRows(
  supabase: WorkerSupabase,
  jobId: string,
  productId: string
): Promise<JobReferenceSetRow[]> {
  const { data, error } = await supabase
    .from(T.generation_job_reference_sets)
    .select(`
      reference_set_id,
      role,
      display_order,
      image_count,
      selected_image_ids,
      ${T.reference_sets}!inner(product_id)
    `)
    .eq('job_id', jobId)
    .eq(`${T.reference_sets}.product_id`, productId)
    .order('display_order', { ascending: true })

  if (error) {
    throw new Error(`Failed to load reference set attachments: ${error.message}`)
  }
  return (data || []) as unknown as JobReferenceSetRow[]
}

async function fetchReferenceImagesForSets(
  supabase: WorkerSupabase,
  referenceSetIds: string[]
): Promise<WorkerReferenceImage[]> {
  if (referenceSetIds.length === 0) return []
  const { data, error } = await supabase
    .from(T.reference_images)
    .select(REFERENCE_IMAGE_SELECT)
    .in('reference_set_id', referenceSetIds)
    .order('display_order', { ascending: true })

  if (error) {
    throw new Error(`Failed to load reference images: ${error.message}`)
  }

  return (data || []) as unknown as WorkerReferenceImage[]
}

async function fetchSourceImage(
  supabase: WorkerSupabase,
  sourceImageId: string | null | undefined,
  productId: string
): Promise<SourceImageRecord | null> {
  if (!sourceImageId) return null

  const { data, error } = await supabase
    .from(T.generated_images)
    .select('storage_path, mime_type')
    .eq('id', sourceImageId)
    .eq('product_id', productId)
    .eq('media_type', 'image')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load source image: ${error.message}`)
  }

  if (!data) {
    throw new Error('Source image not found for generation job')
  }

  return data as SourceImageRecord
}

async function resolveGeminiApiKeyForJob(
  product: ProductRecord
): Promise<string | undefined> {
  const productKey = resolveGoogleApiKey(product.global_style_settings)
  if (productKey) return productKey

  const project = Array.isArray(product.prodai_projects)
    ? product.prodai_projects[0]
    : product.prodai_projects
  return resolveGoogleApiKey(project?.global_style_settings ?? null)
}

function limitReferenceImages(
  images: WorkerReferenceImage[],
  limit: number | null | undefined
): WorkerReferenceImage[] {
  const maxImages = limit ?? images.length
  return images.slice(0, maxImages)
}

function pickReferenceImagesByIds(
  images: WorkerReferenceImage[],
  selectedIds: string[]
): WorkerReferenceImage[] {
  const byId = new Map(images.map((img) => [img.id, img]))
  const picked: WorkerReferenceImage[] = []
  for (const id of selectedIds) {
    const img = byId.get(id)
    if (img) picked.push(img)
  }
  return picked
}

async function getCurrentJobCounts(
  supabase: WorkerSupabase,
  job: GenerationJobRecord
): Promise<JobCounts> {
  const fallbackCounts = getJobCounts(job)

  const { data, error } = await supabase
    .from(T.generation_jobs)
    .select('completed_count, failed_count')
    .eq('id', job.id)
    .maybeSingle()

  if (error || !data) {
    return fallbackCounts
  }

  const latestCounts = getJobCounts(data as Pick<GenerationJobRecord, 'completed_count' | 'failed_count'>)
  return {
    completed: Math.max(fallbackCounts.completed, latestCounts.completed),
    failed: Math.max(fallbackCounts.failed, latestCounts.failed),
  }
}

async function downloadStorageBase64(
  supabase: WorkerSupabase,
  bucket: string,
  storagePath: string,
  mimeType: string,
  context: string
): Promise<Base64ReferenceImage> {
  const MAX_RETRIES = 3
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(storagePath)

      if (error) {
        lastError = new Error(`${context}: ${error.message}`)
        if (isRetriableError(error) && attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        throw lastError
      }

      if (!data) {
        lastError = new Error(`${context}: download returned no data`)
        throw lastError
      }

      const arrayBuffer = await data.arrayBuffer()
      return {
        mimeType,
        base64: Buffer.from(arrayBuffer).toString('base64'),
      }
    } catch (err) {
      if (err instanceof Error && err === lastError) {
        lastError = err
      } else {
        const message = err instanceof Error ? err.message : String(err)
        lastError = new Error(`${context}: ${message}`)
      }
      if (isRetriableError(lastError) && attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw lastError
    }
  }

  throw lastError ?? new Error(`${context}: download failed after ${MAX_RETRIES} attempts`)
}

async function buildReferenceImagePayloads(
  supabase: WorkerSupabase,
  sourceImage: SourceImageRecord | null,
  referenceImages: WorkerReferenceImage[]
): Promise<Base64ReferenceImage[]> {
  const [sourcePayload, referencePayloads] = await Promise.all([
    sourceImage
      ? downloadStorageBase64(
        supabase,
        'generated-images',
        sourceImage.storage_path,
        sourceImage.mime_type,
        'Failed to download source image'
      )
      : Promise.resolve(null),
    Promise.all(
    referenceImages.map((image) => downloadStorageBase64(
      supabase,
      'reference-images',
      image.storage_path,
      image.mime_type,
      'Failed to download reference image'
    ))
    ),
  ])

  return [
    ...(sourcePayload ? [sourcePayload] : []),
    ...referencePayloads,
  ]
}

async function cleanupGeneratedImageAssets(
  supabase: WorkerSupabase,
  paths: string[]
) {
  const uniquePaths = [...new Set(paths.filter(Boolean))]
  if (uniquePaths.length === 0) return

  try {
    const { error } = await supabase.storage
      .from('generated-images')
      .remove(uniquePaths)
    if (error) {
      log.warn('Failed to clean up generated image assets', {
        assetCount: uniquePaths.length,
        error: sanitizeWorkerErrorMessage(error.message, 'Storage cleanup failed'),
      })
    }
  } catch (err) {
    // Cleanup failures should not hide the original generation error.
    log.warn('Failed to clean up generated image assets', {
      assetCount: uniquePaths.length,
      error: sanitizeWorkerErrorMessage(err, 'Storage cleanup failed'),
    })
  }
}

async function loadImageJobResources(
  supabase: WorkerSupabase,
  job: GenerationJobRecord
): Promise<LoadedImageJobResources> {
  const jobRefSets = await fetchJobReferenceSetRows(supabase, job.id, job.product_id)
  if (jobRefSets.length === 0 && !job.source_image_id) {
    throw new Error('Image generation job has no reference sets attached')
  }

  const uniqueSetIds = [...new Set(jobRefSets.map(r => r.reference_set_id))]

  const [product, refImages, sourceImage] = await Promise.all([
    fetchProductRecord(supabase, job.product_id),
    fetchReferenceImagesForSets(supabase, uniqueSetIds),
    fetchSourceImage(supabase, job.source_image_id, job.product_id),
  ])

  const imagesBySet = new Map<string, WorkerReferenceImage[]>()
  for (const img of refImages) {
    if (!img.reference_set_id) continue
    const arr = imagesBySet.get(img.reference_set_id) ?? []
    arr.push(img)
    imagesBySet.set(img.reference_set_id, arr)
  }

  const orderedReferenceImages: WorkerReferenceImage[] = []
  for (const row of jobRefSets) {
    const setImages = imagesBySet.get(row.reference_set_id) ?? []
    if (row.selected_image_ids && row.selected_image_ids.length > 0) {
      orderedReferenceImages.push(...pickReferenceImagesByIds(setImages, row.selected_image_ids))
    } else {
      orderedReferenceImages.push(...limitReferenceImages(setImages, row.image_count))
    }
  }

  const [geminiApiKey, referenceImages] = await Promise.all([
    resolveGeminiApiKeyForJob(product),
    buildReferenceImagePayloads(supabase, sourceImage, orderedReferenceImages),
  ])

  return {
    geminiApiKey,
    referenceImages,
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

async function fetchRecordedImageVariationNumbers(
  supabase: WorkerSupabase,
  job: Pick<GenerationJobRecord, 'id' | 'product_id'>,
  variationNumbers: number[]
): Promise<Set<number>> {
  if (variationNumbers.length === 0) return new Set()

  const requested = new Set(variationNumbers)
  const { data, error } = await supabase
    .from(T.generated_images)
    .select('variation_number')
    .eq('job_id', job.id)
    .eq('product_id', job.product_id)
    .eq('media_type', 'image')
    .in('variation_number', variationNumbers)
    .order('variation_number', { ascending: true })

  if (error) {
    throw new Error(`Failed to load recorded generated variations: ${error.message}`)
  }

  const recorded = new Set<number>()
  for (const row of (data || []) as RecordedVariationRow[]) {
    const variationNumber = Number(row.variation_number)
    if (Number.isSafeInteger(variationNumber) && requested.has(variationNumber)) {
      recorded.add(variationNumber)
    }
  }

  return recorded
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
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('abort') ||
    message.includes('server error') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('service unavailable') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('504') ||
    message.includes('503') ||
    message.includes('502')
  )
}

function isDuplicateGeneratedImageInsertError(error: SupabaseErrorLike | null | undefined) {
  const code = error?.code ?? ''
  const message = error?.message?.toLowerCase() ?? ''
  return (
    code === '23505' ||
    message.includes('duplicate key') ||
    message.includes('unique constraint')
  )
}

async function persistProgress(
  supabase: WorkerSupabase,
  jobId: string,
  progress: ProgressSnapshot,
  plan: VariationPlan
) {
  const nextFailedCount = plan.startingFailed + progress.failCount
  await updateGenerationJob(
    supabase,
    jobId,
    {
      completed_count: plan.startingCompleted + progress.successCount,
      failed_count: nextFailedCount,
      ...(!progress.lastError && nextFailedCount === 0 && progress.successCount > 0
        ? { error_message: null }
        : {}),
      ...(progress.lastError ? { error_message: progress.lastError } : {}),
    },
    {
      expectedStatuses: ['pending', 'running'],
      allowNoop: true,
      context: 'Failed to persist generation job progress',
    }
  )
}

function createProgressPersister(
  supabase: WorkerSupabase,
  jobId: string,
  plan: VariationPlan
) {
  let pendingWrite = Promise.resolve()

  return {
    persist(progress: ProgressSnapshot) {
      pendingWrite = pendingWrite.then(() => persistProgress(supabase, jobId, progress, plan))
      return pendingWrite
    },
    flush() {
      return pendingWrite
    },
  }
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
    const [thumbnail, preview] = await createThumbnailAndPreview(imageBuffer)

    const storagePath = buildImageStoragePath(job.product_id, job.id, variationNumber, promptSlug, extension)
    const thumbPath = buildThumbnailPath(storagePath, thumbnail.extension)
    const previewPath = buildPreviewPath(storagePath, preview.extension)

    const uploadResults = await Promise.all([
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

    const generatedPaths = [storagePath, thumbPath, previewPath]
    const successfulUploads = generatedPaths.filter((_, index) => !uploadResults[index]?.error)
    const [imageUploadResult, thumbUploadResult, previewUploadResult] = uploadResults
    const previewUploadError = previewUploadResult?.error

    if (imageUploadResult?.error || thumbUploadResult?.error || previewUploadError) {
      await cleanupGeneratedImageAssets(supabase, successfulUploads)

      if (imageUploadResult?.error) {
        throw new Error(`Failed to upload generated image: ${imageUploadResult.error.message}`)
      }
      if (thumbUploadResult?.error) {
        throw new Error(`Failed to upload image thumbnail: ${thumbUploadResult.error.message}`)
      }
      throw new Error(`Failed to upload image preview: ${previewUploadError?.message || 'unknown upload failure'}`)
    }

    const { error: insertError } = await supabase.from(T.generated_images).insert({
      product_id: job.product_id,
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
      if (isDuplicateGeneratedImageInsertError(insertError)) {
        try {
          const recorded = await fetchRecordedImageVariationNumbers(supabase, job, [variationNumber])
          if (recorded.has(variationNumber)) {
            return
          }
        } catch (err) {
          // Fall through to the original insert error and cleanup path. A
          // duplicate is only safe to treat as success after verification.
          log.warn('Failed to verify duplicate generated image record', {
            jobId: job.id,
            variationNumber,
            error: sanitizeWorkerErrorMessage(err, 'Duplicate verification failed'),
          })
        }
      }
      await cleanupGeneratedImageAssets(supabase, generatedPaths)
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
  timeBudgetMs: number,
  statusRefreshIntervalMs: number
) {
  const startedAt = Date.now()
  let cancelled = false
  let lastStatusCheckAt = 0

  const shouldStop = async () => {
    if (Date.now() - startedAt > timeBudgetMs) return true
    if (Date.now() - lastStatusCheckAt < statusRefreshIntervalMs) return cancelled

    lastStatusCheckAt = Date.now()
    const { data, error } = await supabase
      .from(T.generation_jobs)
      .select('status')
      .eq('id', jobId)
      .single()

    if (error) {
      // A transient status read must not abort a job that is otherwise making
      // progress. Keep the last known cancellation state and re-check on the
      // next interval; the overall time budget still bounds total runtime.
      return cancelled
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
  recordedVariationNumbers: Set<number>,
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
  const stopChecker = createShouldStopChecker(
    supabase,
    job.id,
    config.timeBudgetMs,
    config.statusRefreshIntervalMs
  )
  const progressPersister = createProgressPersister(supabase, job.id, plan)
  let fatalError: unknown = null

  const worker = async () => {
    while (nextIndex < plan.variationNumbers.length && fatalError === null) {
      if (await stopChecker.shouldStop()) {
        break
      }
      if (fatalError !== null) {
        break
      }

      const variationNumber = plan.variationNumbers[nextIndex]
      nextIndex += 1

      try {
        if (!recordedVariationNumbers.has(variationNumber)) {
          await runVariationWithRetry(supabase, job, variationNumber, plan.promptSlug, resources, config)
        }
        progress.successCount += 1
      } catch (err) {
        progress.failCount += 1
        progress.lastError = sanitizeWorkerErrorMessage(err, 'Variation failed')
      } finally {
        progress.processed += 1
        await progressPersister.persist({
          successCount: progress.successCount,
          failCount: progress.failCount,
          lastError: progress.lastError,
        })
      }
    }
  }

  const workerCount = Math.min(config.parallelism, plan.variationNumbers.length)
  await Promise.allSettled(
    Array.from({ length: workerCount }, async () => {
      try {
        await worker()
      } catch (err) {
        fatalError ??= err
      }
    })
  )

  if (fatalError !== null) {
    throw fatalError
  }

  await progressPersister.flush()

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

  if (result.failedCount === 0 && !result.lastError && result.completedCount > 0) {
    updates.error_message = null
  }

  if (finalCompleted) {
    updates.completed_at = new Date().toISOString()
    if (allFailed) {
      updates.error_message = result.lastError || 'All variations failed'
    }
  }

  const updated = await updateGenerationJob(
    supabase,
    job.id,
    updates,
    {
      expectedStatuses: ['pending', 'running'],
      allowNoop: true,
      context: 'Failed to persist final generation job state',
    }
  )

  if (!updated) {
    return resolveTerminalUpdateConflict(
      supabase,
      job.id,
      result.processed,
      'Failed to persist final generation job state'
    )
  }

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
  const claimedJob = await claimPendingJobById(supabase, jobId)
  if (!claimedJob) {
    return getLatestJobResult(supabase, jobId)
  }

  try {
    if (normalizeJobType(claimedJob) === 'video') {
      // Await inside the try so any unexpected throw (e.g. a status-conflict
      // during the completion update) routes through the failure handler
      // below instead of escaping uncaught.
      return await processVideoJob(claimedJob, supabase)
    }

    const plan = createVariationPlan(claimedJob, config.batchSize)
    if (plan.variationNumbers.length === 0) {
      return persistFinalImageJobState(supabase, claimedJob, {
        processed: 0,
        completedCount: plan.startingCompleted,
        failedCount: plan.startingFailed,
        lastError: claimedJob.error_message,
        cancelled: false,
      })
    }

    const recordedVariationNumbers = await fetchRecordedImageVariationNumbers(
      supabase,
      claimedJob,
      plan.variationNumbers
    )
    const hasUnrecordedVariations = plan.variationNumbers.some(
      (variationNumber) => !recordedVariationNumbers.has(variationNumber)
    )
    const resources = hasUnrecordedVariations
      ? await loadImageJobResources(supabase, claimedJob)
      : { referenceImages: [] }
    const variationResult = await processVariations(
      supabase,
      claimedJob,
      plan,
      recordedVariationNumbers,
      resources,
      config
    )
    return persistFinalImageJobState(supabase, claimedJob, variationResult)
  } catch (err) {
    const safeMessage = sanitizeWorkerErrorMessage(err, 'Generation job failed')
    try {
      await markClaimedJobFailed(supabase, claimedJob, safeMessage)
    } catch (persistError) {
      // Persisting the failed state is best-effort. If it fails (e.g. a
      // transient DB error or a concurrent status change), never let that
      // mask the original generation error the caller needs for logging.
      log.error('Failed to persist claimed job failure state', {
        jobId: claimedJob.id,
        error: sanitizeWorkerErrorMessage(persistError, 'Failure state persistence failed'),
      })
    }
    throw err
  }
}
