import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { slugify, extractVideoThumbnail, buildThumbnailPath } from '@/lib/image-utils'
import { resolveGoogleApiKey } from '@/lib/google-api-keys'
import type { GlobalStyleSettings } from '@/lib/types'
import { isLtxModel, normalizeDurationValue, parsePositiveNumber } from '@/lib/video-constants'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_VEO_MODEL = 'veo-3.1-generate-preview'
const DEFAULT_VEO_POLL_INTERVAL_MS = 10_000
const DEFAULT_VEO_POLL_TIMEOUT_MS = 600_000
const DEFAULT_LTX_API_BASE_URL = 'https://api.ltx.video/v1'
const DEFAULT_LTX_MODEL = 'ltx-2-pro'
const DEFAULT_LTX_DURATION_SECONDS = 8
const DEFAULT_LTX_RESOLUTION = '1920x1080'

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
type GeneratedImageFrame = { storage_path: string | null; mime_type: string | null }
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
}
type SceneGenerationContext = {
  scene: SceneRecord
  resolvedModel: string
  geminiApiKey?: string
  frameRefs: FrameRefs
  videoSettings: SceneVideoSettings
}

const isVeoModel = (model: string) => model.toLowerCase().startsWith('veo')

function getResponseMimeType(response: Response, fallback: string) {
  return (response.headers.get('content-type') || fallback).split(';')[0]
}

async function getResponseErrorMessage(response: Response) {
  const body = (await response.text()).trim()
  return body || response.statusText || 'Unknown error'
}

function getPositiveNumberOrDefault(value: unknown, fallback: number) {
  return parsePositiveNumber(value) ?? fallback
}

function getBufferResult(buffer: Buffer, mimeType: string): VideoGenerationResult {
  const extension = mimeType.includes('/') ? mimeType.split('/')[1] : 'mp4'
  return {
    buffer,
    mimeType,
    extension: extension || 'mp4',
  }
}

async function createFrameRef(supabase: ReturnType<typeof createServiceClient>, imageId: string) {
  const { data: image } = await supabase
    .from(T.generated_images)
    .select('storage_path, mime_type')
    .eq('id', imageId)
    .single<GeneratedImageFrame>()

  if (!image?.storage_path) return undefined

  const { data: signed } = await supabase.storage
    .from('generated-images')
    .createSignedUrl(image.storage_path, SIGNED_URL_TTL_SECONDS)

  if (!signed?.signedUrl) return undefined

  return {
    url: signed.signedUrl,
    mimeType: image.mime_type || 'image/png',
  }
}

async function fetchFrameBytes(frameRef: FrameRef, label: 'start' | 'end') {
  const response = await fetch(frameRef.url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${label} frame (${response.status})`)
  }

  return {
    mimeType: frameRef.mimeType || getResponseMimeType(response, 'image/png'),
    bytesBase64Encoded: Buffer.from(await response.arrayBuffer()).toString('base64'),
  }
}

async function pollVeoOperation(
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

    const statusResp = await fetch(`${baseUrl}/${operationName}`, {
      headers: { 'x-goog-api-key': apiKey },
    })
    if (!statusResp.ok) {
      const message = await getResponseErrorMessage(statusResp)
      throw new Error(`Veo operation error: ${statusResp.status} ${message}`)
    }

    operation = await statusResp.json()
  }

  return operation
}

function getVeoConfig(apiKeyOverride?: string | null): VeoConfig {
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

async function buildVeoRequestParts(
  prompt: string,
  frameRefs: FrameRefs,
  settings: SceneVideoSettings,
  model: string
): Promise<VeoRequestParts> {
  const instance: Record<string, unknown> = { prompt }
  const parameters: Record<string, unknown> = {}

  if (frameRefs.start?.url) {
    instance.image = await fetchFrameBytes(frameRefs.start, 'start')
  }

  if (frameRefs.end?.url) {
    if (!frameRefs.start?.url) {
      console.warn('[Veo] Ignoring end frame because no start frame was provided.')
    } else {
      instance.lastFrame = await fetchFrameBytes(frameRefs.end, 'end')
    }
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
  const response = await fetch(
    `${config.baseUrl}/models/${config.model}:predictLongRunning`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(payload),
    }
  )

  if (!response.ok) {
    const message = await getResponseErrorMessage(response)
    throw new Error(`Veo API error: ${response.status} ${message}`)
  }

  const operation = await response.json()
  const operationName = operation?.name
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

function getVeoVideoUri(operation: Record<string, unknown>) {
  if (operation?.error) {
    throw new Error(`Veo operation error: ${getVeoOperationErrorMessage(operation.error)}`)
  }

  const response = operation.response as
    | { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } }
    | undefined
  const videoUri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
  if (!videoUri) throw new Error('No video URI in Veo response')

  return videoUri
}

async function downloadVeoVideo(videoUri: string, apiKey: string) {
  const videoResp = await fetch(videoUri, {
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'follow',
  })
  if (!videoResp.ok) throw new Error(`Failed to download video (${videoResp.status})`)

  const videoBuffer = Buffer.from(await videoResp.arrayBuffer())
  return getBufferResult(videoBuffer, getResponseMimeType(videoResp, 'video/mp4'))
}

async function loadSceneOrThrow(
  supabase: ReturnType<typeof createServiceClient>,
  sceneId: string
): Promise<SceneRecord> {
  const { data: scene, error: sceneErr } = await supabase
    .from(T.storyboard_scenes)
    .select('*')
    .eq('id', sceneId)
    .single<SceneRecord>()

  if (sceneErr || !scene) throw new Error('Scene not found')
  if (!scene.motion_prompt) throw new Error('Scene has no motion prompt')

  return scene
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

  let geminiApiKey = resolveGoogleApiKey(product?.global_style_settings ?? null)
  if (geminiApiKey || !product?.project_id) return geminiApiKey

  const { data: project } = await supabase
    .from(T.projects)
    .select('global_style_settings')
    .eq('id', product.project_id)
    .single<ProjectRecord>()

  return resolveGoogleApiKey(project?.global_style_settings ?? null)
}

function buildSceneVideoSettings(scene: SceneRecord, model: string): SceneVideoSettings {
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
  const [startFrameRef, endFrameRef] = await Promise.all([
    scene.start_frame_image_id
      ? createFrameRef(supabase, scene.start_frame_image_id)
      : Promise.resolve(undefined),
    scene.end_frame_image_id && !isLtxModel(model)
      ? createFrameRef(supabase, scene.end_frame_image_id)
      : Promise.resolve(undefined),
  ])

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
  const scene = await loadSceneOrThrow(supabase, sceneId)
  const resolvedModel = model || scene.generation_model || 'veo3'

  const [geminiApiKey, frameRefs] = await Promise.all([
    resolveSceneGeminiApiKey(supabase, productId),
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

  if (insertErr) throw new Error(insertErr.message)
  return record
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

  return createGeneratedVideoRecord(supabase, scene, jobId, storagePath, thumbStoragePath, result)
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

function getLtxConfig(settings: SceneVideoSettings): LtxConfig {
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
  }
}

function buildLtxPayload(
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

  const response = await fetch(`${config.baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const message = await getResponseErrorMessage(response)
    throw new Error(`LTX API error: ${response.status} ${message}`)
  }

  const videoBuffer = Buffer.from(await response.arrayBuffer())
  return getBufferResult(videoBuffer, getResponseMimeType(response, 'video/mp4'))
}
