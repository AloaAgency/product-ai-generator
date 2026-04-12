import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { slugify, extractVideoThumbnail, buildThumbnailPath } from '@/lib/image-utils'
import { resolveGoogleApiKey } from '@/lib/google-api-keys'
import type { GlobalStyleSettings } from '@/lib/types'
import { isLtxModel, normalizeDurationValue, parsePositiveNumber } from '@/lib/video-constants'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
const MAX_PROMPT_LENGTH = 4_000
const MAX_FRAME_BYTES = 20 * 1024 * 1024
const DEFAULT_FETCH_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const DEFAULT_VEO_MODEL = 'veo-3.1-generate-preview'
const DEFAULT_VEO_POLL_INTERVAL_MS = 10_000
const DEFAULT_VEO_POLL_TIMEOUT_MS = 600_000
const DEFAULT_EXTERNAL_FETCH_RETRIES = 2
const EXTERNAL_FETCH_RETRY_BASE_MS = 1_000
const DEFAULT_LTX_API_BASE_URL = 'https://api.ltx.video/v1'
const DEFAULT_LTX_MODEL = 'ltx-2-pro'
const DEFAULT_LTX_DURATION_SECONDS = 8
const DEFAULT_LTX_RESOLUTION = '1920x1080'
const SCENE_SELECT_COLUMNS = [
  'id',
  'title',
  'motion_prompt',
  'generation_model',
  'start_frame_image_id',
  'end_frame_image_id',
  'video_resolution',
  'video_aspect_ratio',
  'video_duration_seconds',
  'video_fps',
  'video_generate_audio',
].join(', ')

type FrameRef = { url: string; mimeType: string }
type SceneVideoSettings = {
  resolution?: string | null
  aspectRatio?: string | null
  durationSeconds?: number | null
  fps?: number | null
  generateAudio?: boolean | null
}

type VideoGenerationResult = { buffer: Buffer; mimeType: string; extension: string }
type FrameRefs = { start?: FrameRef; end?: FrameRef }
type GeneratedImageFrame = { id: string; storage_path: string | null; mime_type: string | null }
type SceneRecord = {
  id: string
  title: string | null
  motion_prompt: string | null
  generation_model: string | null
  start_frame_image_id: string | null
  end_frame_image_id: string | null
  video_resolution: string | null
  video_aspect_ratio: string | null
  video_duration_seconds: number | null
  video_fps: number | null
  video_generate_audio: boolean | null
}
type SceneWithMotionPrompt = SceneRecord & { motion_prompt: string }
type ProductRecord = {
  project_id: string | null
  global_style_settings: GlobalStyleSettings | null
}
type ProjectRecord = { global_style_settings: GlobalStyleSettings | null }
type VeoConfig = {
  apiKey: string
  baseUrl: string
  model: string
  pollIntervalMs: number
  timeoutMs: number
  shouldLog: boolean
}
type VeoRequestParts = {
  instance: Record<string, unknown>
  parameters: Record<string, unknown>
}
type LtxConfig = {
  apiKey: string
  baseUrl: string
  model: string
  resolution: string
  durationSeconds: number
  requestTimeoutMs: number
}
type SceneGenerationContext = {
  scene: SceneWithMotionPrompt
  resolvedModel: string
  geminiApiKey?: string
  frameRefs: FrameRefs
  videoSettings: SceneVideoSettings
}

const isVeoModel = (model: string) => model.toLowerCase().startsWith('veo')

function sanitizeExternalErrorMessage(
  value: string,
  fallback: string,
  maxLength = 240
) {
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|authorization|secret|signature|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .trim()

  if (!normalized) return fallback
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function createExternalServiceError(context: string, detail: string) {
  return new Error(`${context}: ${sanitizeExternalErrorMessage(detail, 'Unknown error')}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getResponseMimeType(response: Response, fallback: string) {
  return (response.headers.get('content-type') || fallback).split(';')[0]
}

async function getResponseErrorMessage(response: Response) {
  const body = sanitizeExternalErrorMessage(await response.text(), '')
  return body || sanitizeExternalErrorMessage(response.statusText, 'Unknown error')
}

function getPositiveNumberOrDefault(value: unknown, fallback: number) {
  return parsePositiveNumber(value) ?? fallback
}

function validateVideoPrompt(prompt: string) {
  const normalized = prompt.trim()
  if (!normalized) throw new Error('Scene has no motion prompt')
  if (normalized.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Scene motion prompt exceeds ${MAX_PROMPT_LENGTH} characters`)
  }
  return normalized
}

function getConfiguredTimeout(value: unknown, fallback: number) {
  return Math.max(1_000, Math.round(getPositiveNumberOrDefault(value, fallback)))
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  errorContext: string
) {
  const { signal, clear } = createTimeoutSignal(timeoutMs)
  try {
    return await fetch(input, { ...init, signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${errorContext} timed out after ${Math.round(timeoutMs / 1000)}s`)
    }

    throw createExternalServiceError(errorContext, error instanceof Error ? error.message : String(error))
  } finally {
    clear()
  }
}

function shouldRetryExternalStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function shouldRetryExternalError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('abort') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  )
}

function getRetryDelayMs(attempt: number) {
  return EXTERNAL_FETCH_RETRY_BASE_MS * Math.pow(2, attempt)
}

async function fetchIdempotentWithRetry(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  errorContext: string,
  options: {
    statusErrorContext?: string
  } = {}
) {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= DEFAULT_EXTERNAL_FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, init, timeoutMs, errorContext)
      if (response.ok) return response

      const error = createExternalServiceError(
        `${options.statusErrorContext || errorContext} (${response.status})`,
        await getResponseErrorMessage(response)
      )

      if (attempt >= DEFAULT_EXTERNAL_FETCH_RETRIES || !shouldRetryExternalStatus(response.status)) {
        throw error
      }

      lastError = error
    } catch (error) {
      if (attempt >= DEFAULT_EXTERNAL_FETCH_RETRIES || !shouldRetryExternalError(error)) {
        throw error
      }

      lastError = error
    }

    await sleep(getRetryDelayMs(attempt))
  }

  throw lastError instanceof Error ? lastError : new Error(`${errorContext}: Unknown error`)
}

async function parseJsonResponse<T>(
  response: Response,
  errorContext: string
): Promise<T> {
  try {
    return await response.json() as T
  } catch (error) {
    throw createExternalServiceError(
      `${errorContext} returned invalid JSON`,
      error instanceof Error ? error.message : String(error)
    )
  }
}

function getBufferResult(buffer: Buffer, mimeType: string): VideoGenerationResult {
  const extension = mimeType.includes('/') ? mimeType.split('/')[1] : 'mp4'
  return {
    buffer,
    mimeType,
    extension: extension || 'mp4',
  }
}

async function loadFrameRefsByImageId(
  supabase: ReturnType<typeof createServiceClient>,
  imageIds: string[]
) {
  const uniqueImageIds = [...new Set(imageIds)]
  if (uniqueImageIds.length === 0) return new Map<string, FrameRef>()

  const { data: images, error: imageError } = await supabase
    .from(T.generated_images)
    .select('id, storage_path, mime_type')
    .in('id', uniqueImageIds)

  if (imageError) {
    throw new Error(`Failed to load frame image: ${imageError.message}`)
  }

  const frames = (images || []).filter(
    (image): image is GeneratedImageFrame => Boolean(image?.id && image.storage_path)
  )
  if (frames.length === 0) return new Map<string, FrameRef>()

  const storagePaths = frames.map((frame) => frame.storage_path as string)
  const { data: signed, error: signedError } = await supabase.storage
    .from('generated-images')
    .createSignedUrls(storagePaths, SIGNED_URL_TTL_SECONDS)

  if (signedError) {
    throw new Error(`Failed to sign frame image: ${signedError.message}`)
  }

  const signedUrlsByPath = new Map<string, string>()
  for (const [index, storagePath] of storagePaths.entries()) {
    const signedUrl = signed?.[index]?.signedUrl
    if (signedUrl) signedUrlsByPath.set(storagePath, signedUrl)
  }

  const frameRefs = new Map<string, FrameRef>()
  for (const frame of frames) {
    const storagePath = frame.storage_path as string
    const signedUrl = signedUrlsByPath.get(storagePath)
    if (!signedUrl) continue

    frameRefs.set(frame.id, {
      url: signedUrl,
      mimeType: frame.mime_type || 'image/png',
    })
  }

  return frameRefs
}

async function fetchFrameBytes(frameRef: FrameRef, label: 'start' | 'end') {
  const response = await fetchIdempotentWithRetry(
    frameRef.url,
    {},
    getConfiguredTimeout(process.env.VIDEO_FRAME_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
    `Failed to fetch ${label} frame`
  )

  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_FRAME_BYTES) {
    throw new Error(`${label[0].toUpperCase()}${label.slice(1)} frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_FRAME_BYTES) {
    throw new Error(`${label[0].toUpperCase()}${label.slice(1)} frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }

  return {
    mimeType: frameRef.mimeType || getResponseMimeType(response, 'image/png'),
    bytesBase64Encoded: buffer.toString('base64'),
  }
}

export async function pollVeoOperation(
  baseUrl: string,
  operationName: string,
  apiKey: string,
  pollIntervalMs: number,
  timeoutMs: number
) {
  const startedAt = Date.now()
  let operation: Record<string, unknown> | null = null

  while (!operation || !operation.done) {
    if (Date.now() - startedAt > timeoutMs) {
      const timeoutSeconds = Math.round(timeoutMs / 1000)
      throw new Error(`Veo generation timed out after ${timeoutSeconds}s`)
    }

    if (operation) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    const statusResp = await fetchIdempotentWithRetry(
      `${baseUrl}/${operationName}`,
      { headers: { 'x-goog-api-key': apiKey } },
      getConfiguredTimeout(process.env.VEO_REQUEST_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
      'Veo operation polling',
      { statusErrorContext: 'Veo operation error' }
    )

    operation = await parseJsonResponse(statusResp, 'Veo operation polling')
  }

  return operation
}

export function getVeoConfig(apiKeyOverride?: string | null): VeoConfig {
  const apiKey = apiKeyOverride || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Google AI API key not configured')

  return {
    apiKey,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: process.env.VEO_MODEL?.trim() || DEFAULT_VEO_MODEL,
    pollIntervalMs: getPositiveNumberOrDefault(
      process.env.VEO_POLL_INTERVAL_MS,
      DEFAULT_VEO_POLL_INTERVAL_MS
    ),
    timeoutMs: getPositiveNumberOrDefault(
      process.env.VEO_POLL_TIMEOUT_MS,
      DEFAULT_VEO_POLL_TIMEOUT_MS
    ),
    shouldLog: process.env.VEO_DEBUG === 'true' || process.env.NODE_ENV !== 'production',
  }
}

export async function buildVeoRequestParts(
  prompt: string,
  frameRefs: FrameRefs,
  settings: SceneVideoSettings,
  model: string
): Promise<VeoRequestParts> {
  const instance: Record<string, unknown> = { prompt }
  const parameters: Record<string, unknown> = {}

  if (frameRefs.end?.url) {
    if (!frameRefs.start?.url) {
      console.warn('[Veo] Ignoring end frame because no start frame was provided.')
    }
  }

  const [startFrame, endFrame] = await Promise.all([
    frameRefs.start?.url ? fetchFrameBytes(frameRefs.start, 'start') : Promise.resolve(undefined),
    frameRefs.start?.url && frameRefs.end?.url
      ? fetchFrameBytes(frameRefs.end, 'end')
      : Promise.resolve(undefined),
  ])

  if (startFrame) {
    instance.image = startFrame
  }

  if (endFrame) {
    instance.lastFrame = endFrame
  }

  const aspectRatio = settings.aspectRatio || process.env.VEO_ASPECT_RATIO
  if (aspectRatio) parameters.aspectRatio = aspectRatio

  const resolution = settings.resolution || process.env.VEO_RESOLUTION
  if (resolution) parameters.resolution = resolution

  const durationSeconds = normalizeDurationValue(
    model,
    settings.durationSeconds ?? process.env.VEO_DURATION_SECONDS,
    resolution,
    !!frameRefs.start,
    !!frameRefs.end
  )
  if (durationSeconds) parameters.durationSeconds = durationSeconds

  const generateAudio = typeof settings.generateAudio === 'boolean' ? settings.generateAudio : null
  if (process.env.VEO_SUPPORTS_AUDIO === 'true' && generateAudio !== null) {
    parameters.generateAudio = generateAudio
  }

  return { instance, parameters }
}

function logVeoParameters(config: VeoConfig, parameters: Record<string, unknown>) {
  if (!config.shouldLog) return

  console.log('[Veo] parameters', {
    model: config.model,
    durationSeconds: parameters.durationSeconds,
    resolution: parameters.resolution,
    aspectRatio: parameters.aspectRatio,
    generateAudio: parameters.generateAudio,
  })
}

async function startVeoOperation(
  config: VeoConfig,
  payload: Record<string, unknown>
): Promise<string> {
  const response = await fetchWithTimeout(
    `${config.baseUrl}/models/${config.model}:predictLongRunning`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(payload),
    },
    getConfiguredTimeout(process.env.VEO_REQUEST_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
    'Veo API request'
  )

  if (!response.ok) {
    const message = await getResponseErrorMessage(response)
    throw createExternalServiceError(`Veo API error (${response.status})`, message)
  }

  const operation = await parseJsonResponse<Record<string, unknown>>(response, 'Veo API request')
  const operationName = typeof operation?.name === 'string' ? operation.name : null
  if (!operationName) throw new Error('No operation name in Veo response')

  return operationName
}

function getVeoOperationErrorMessage(error: unknown) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return JSON.stringify(error)
}

export function getVeoVideoUri(operation: Record<string, unknown>) {
  if (operation?.error) {
    throw createExternalServiceError('Veo operation error', getVeoOperationErrorMessage(operation.error))
  }

  const response = operation.response as
    | { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } }
    | undefined
  const videoUri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
  if (!videoUri) throw new Error('No video URI in Veo response')
  try {
    const parsed = new URL(videoUri)
    if (parsed.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch {
    throw new Error('Invalid video URI in Veo response')
  }

  return videoUri
}

async function downloadVeoVideo(videoUri: string, apiKey: string) {
  const videoResp = await fetchIdempotentWithRetry(
    videoUri,
    {
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'follow',
    },
    getConfiguredTimeout(process.env.VEO_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS),
    'Veo video download'
  )

  const videoBuffer = Buffer.from(await videoResp.arrayBuffer())
  return getBufferResult(videoBuffer, getResponseMimeType(videoResp, 'video/mp4'))
}

async function loadSceneOrThrow(
  supabase: ReturnType<typeof createServiceClient>,
  sceneId: string
): Promise<SceneWithMotionPrompt> {
  const { data: scene, error: sceneErr } = await supabase
    .from(T.storyboard_scenes)
    .select(SCENE_SELECT_COLUMNS)
    .eq('id', sceneId)
    .single<SceneRecord>()

  if (sceneErr || !scene) throw new Error('Scene not found')
  scene.motion_prompt = validateVideoPrompt(scene.motion_prompt || '')

  return scene as SceneWithMotionPrompt
}

async function resolveSceneGeminiApiKey(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string
) {
  const { data: product } = await supabase
    .from(T.products)
    .select('project_id, global_style_settings')
    .eq('id', productId)
    .single<ProductRecord>()

  const geminiApiKey = resolveGoogleApiKey(product?.global_style_settings ?? null)
  if (geminiApiKey || !product?.project_id) return geminiApiKey

  const { data: project } = await supabase
    .from(T.projects)
    .select('global_style_settings')
    .eq('id', product.project_id)
    .single<ProjectRecord>()

  return resolveGoogleApiKey(project?.global_style_settings ?? null)
}

export function buildSceneVideoSettings(scene: SceneRecord, model: string): SceneVideoSettings {
  return {
    resolution: scene.video_resolution,
    aspectRatio: scene.video_aspect_ratio,
    durationSeconds: normalizeDurationValue(
      model,
      scene.video_duration_seconds,
      scene.video_resolution,
      !!scene.start_frame_image_id,
      !!scene.end_frame_image_id
    ),
    fps: scene.video_fps,
    generateAudio: scene.video_generate_audio,
  }
}

async function resolveFrameRefs(
  supabase: ReturnType<typeof createServiceClient>,
  scene: SceneRecord,
  model: string
): Promise<FrameRefs> {
  const endFrameImageId = scene.end_frame_image_id && !isLtxModel(model)
    ? scene.end_frame_image_id
    : null
  const frameRefsByImageId = await loadFrameRefsByImageId(
    supabase,
    [scene.start_frame_image_id, endFrameImageId].filter((imageId): imageId is string => Boolean(imageId))
  )
  const startFrameRef = scene.start_frame_image_id
    ? frameRefsByImageId.get(scene.start_frame_image_id)
    : undefined
  const endFrameRef = endFrameImageId
    ? frameRefsByImageId.get(endFrameImageId)
    : undefined

  return {
    ...(startFrameRef ? { start: startFrameRef } : {}),
    ...(endFrameRef ? { end: endFrameRef } : {}),
  }
}

async function loadSceneGenerationContext(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string,
  sceneId: string,
  model?: string
): Promise<SceneGenerationContext> {
  const scenePromise = loadSceneOrThrow(supabase, sceneId)
  const geminiApiKeyPromise = resolveSceneGeminiApiKey(supabase, productId)
  const scene = await scenePromise
  const resolvedModel = model || scene.generation_model || 'veo3'

  const [geminiApiKey, frameRefs] = await Promise.all([
    geminiApiKeyPromise,
    resolveFrameRefs(supabase, scene, resolvedModel),
  ])

  return {
    scene,
    resolvedModel,
    geminiApiKey,
    frameRefs,
    videoSettings: buildSceneVideoSettings(scene, resolvedModel),
  }
}

async function uploadGeneratedVideo(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string,
  sceneId: string,
  prompt: string,
  result: VideoGenerationResult
) {
  const fileName = `video-${slugify(prompt)}-${Date.now()}.${result.extension}`
  const storagePath = `products/${productId}/scenes/${sceneId}/${fileName}`

  const { error: uploadErr } = await supabase.storage
    .from('generated-videos')
    .upload(storagePath, result.buffer, { contentType: result.mimeType })

  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)
  return storagePath
}

async function uploadVideoThumbnail(
  supabase: ReturnType<typeof createServiceClient>,
  storagePath: string,
  videoBuffer: Buffer
) {
  try {
    const thumb = await extractVideoThumbnail(videoBuffer)
    const thumbStoragePath = buildThumbnailPath(storagePath, thumb.extension)

    const { error: thumbUploadErr } = await supabase.storage
      .from('generated-videos')
      .upload(thumbStoragePath, thumb.buffer, { contentType: thumb.mimeType })

    if (thumbUploadErr) {
      console.warn(`Video thumbnail upload failed: ${thumbUploadErr.message}`)
      return null
    }

    return thumbStoragePath
  } catch (err) {
    console.warn('Video thumbnail extraction failed:', err)
    return null
  }
}

async function createGeneratedVideoRecord(
  supabase: ReturnType<typeof createServiceClient>,
  scene: SceneRecord,
  jobId: string | null | undefined,
  storagePath: string,
  thumbStoragePath: string | null,
  result: VideoGenerationResult
) {
  const { data: record, error: insertErr } = await supabase
    .from(T.generated_images)
    .insert({
      job_id: jobId || null,
      variation_number: 1,
      storage_path: storagePath,
      thumb_storage_path: thumbStoragePath,
      mime_type: result.mimeType,
      file_size: result.buffer.length,
      media_type: 'video',
      scene_id: scene.id,
      scene_name: scene.title || null,
      approval_status: 'pending',
    })
    .select()
    .single()

  if (insertErr) throw new Error(`Failed to record generated video: ${insertErr.message}`)
  return record
}

async function cleanupUploadedVideoAssets(
  supabase: ReturnType<typeof createServiceClient>,
  storagePaths: Array<string | null | undefined>
) {
  const paths = storagePaths.filter((path): path is string => !!path)
  if (paths.length === 0) return

  try {
    const { error } = await supabase.storage
      .from('generated-videos')
      .remove(paths)

    if (error) {
      console.warn('Failed to clean up uploaded video assets:', error.message)
    }
  } catch (error) {
    console.warn('Failed to clean up uploaded video assets:', error)
  }
}

export async function generateSceneVideo(
  productId: string,
  sceneId: string,
  model?: string,
  jobId?: string | null
) {
  const supabase = createServiceClient()
  const { scene, resolvedModel, geminiApiKey, frameRefs, videoSettings } =
    await loadSceneGenerationContext(supabase, productId, sceneId, model)

  const isLtx = isLtxModel(resolvedModel)
  const isVeo = isVeoModel(resolvedModel)

  // Generate video
  let result: VideoGenerationResult

  if (isVeo) {
    result = await generateWithVeo3(scene.motion_prompt, frameRefs, videoSettings, geminiApiKey)
  } else if (isLtx) {
    result = await generateWithLtx(scene.motion_prompt, frameRefs, videoSettings)
  } else {
    throw new Error(`Unsupported model: ${resolvedModel}`)
  }

  const storagePath = await uploadGeneratedVideo(
    supabase,
    productId,
    sceneId,
    scene.motion_prompt,
    result
  )
  const thumbStoragePath = await uploadVideoThumbnail(supabase, storagePath, result.buffer)

  try {
    return await createGeneratedVideoRecord(supabase, scene, jobId, storagePath, thumbStoragePath, result)
  } catch (error) {
    await cleanupUploadedVideoAssets(supabase, [storagePath, thumbStoragePath])
    throw error
  }
}

// ---------------------------------------------------------------------------
// Video generation integrations
// ---------------------------------------------------------------------------

async function generateWithVeo3(
  prompt: string,
  frameRefs: FrameRefs,
  settings: SceneVideoSettings,
  apiKeyOverride?: string | null
) : Promise<VideoGenerationResult> {
  const config = getVeoConfig(apiKeyOverride)
  const { instance, parameters } = await buildVeoRequestParts(prompt, frameRefs, settings, config.model)
  logVeoParameters(config, parameters)

  const payload: Record<string, unknown> = { instances: [instance] }
  if (Object.keys(parameters).length) payload.parameters = parameters
  const operationName = await startVeoOperation(config, payload)
  const operation = await pollVeoOperation(
    config.baseUrl,
    operationName,
    config.apiKey,
    config.pollIntervalMs,
    config.timeoutMs
  )

  return downloadVeoVideo(getVeoVideoUri(operation), config.apiKey)
}

export function getLtxConfig(settings: SceneVideoSettings): LtxConfig {
  const apiKey = process.env.LTX_API_KEY
  if (!apiKey) throw new Error('LTX_API_KEY not configured')

  return {
    apiKey,
    baseUrl: (process.env.LTX_API_BASE_URL || DEFAULT_LTX_API_BASE_URL).replace(/\/$/, ''),
    model: process.env.LTX_MODEL || DEFAULT_LTX_MODEL,
    resolution: settings.resolution || process.env.LTX_RESOLUTION || DEFAULT_LTX_RESOLUTION,
    durationSeconds: getPositiveNumberOrDefault(
      settings.durationSeconds ?? process.env.LTX_DURATION,
      DEFAULT_LTX_DURATION_SECONDS
    ),
    requestTimeoutMs: getConfiguredTimeout(
      process.env.LTX_REQUEST_TIMEOUT_MS,
      DEFAULT_DOWNLOAD_TIMEOUT_MS
    ),
  }
}

export function buildLtxPayload(
  prompt: string,
  frameRefs: FrameRefs,
  settings: SceneVideoSettings,
  config: LtxConfig
) {
  const payload: Record<string, unknown> = {
    prompt,
    model: config.model,
    duration: config.durationSeconds,
    resolution: config.resolution,
  }

  const fps = typeof settings.fps === 'number' && settings.fps > 0 ? settings.fps : null
  if (fps) payload.fps = fps

  const generateAudio = typeof settings.generateAudio === 'boolean' ? settings.generateAudio : null
  if (generateAudio !== null) payload.generate_audio = generateAudio

  const endpoint = frameRefs.start?.url ? 'image-to-video' : 'text-to-video'
  if (frameRefs.start?.url) payload.image_uri = frameRefs.start.url

  return { endpoint, payload }
}

async function generateWithLtx(
  prompt: string,
  frameRefs: FrameRefs,
  settings: SceneVideoSettings
): Promise<VideoGenerationResult> {
  const config = getLtxConfig(settings)
  const { endpoint, payload } = buildLtxPayload(prompt, frameRefs, settings, config)

  const response = await fetchWithTimeout(
    `${config.baseUrl}/${endpoint}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    },
    config.requestTimeoutMs,
    'LTX API request'
  )

  if (!response.ok) {
    const message = await getResponseErrorMessage(response)
    throw createExternalServiceError(`LTX API error (${response.status})`, message)
  }

  const videoBuffer = Buffer.from(await response.arrayBuffer())
  return getBufferResult(videoBuffer, getResponseMimeType(response, 'video/mp4'))
}
