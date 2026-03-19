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

export async function generateSceneVideo(
  productId: string,
  sceneId: string,
  model?: string,
  jobId?: string | null
) {
  const supabase = createServiceClient()

  // Fetch the scene
  const { data: scene, error: sceneErr } = await supabase
    .from(T.storyboard_scenes)
    .select('*')
    .eq('id', sceneId)
    .single()

  if (sceneErr || !scene) throw new Error('Scene not found')
  if (!scene.motion_prompt) throw new Error('Scene has no motion prompt')

  const { data: product } = await supabase
    .from(T.products)
    .select('project_id, global_style_settings')
    .eq('id', productId)
    .single()

  let geminiApiKey = resolveGoogleApiKey(product?.global_style_settings as GlobalStyleSettings | null)

  if (!geminiApiKey && product?.project_id) {
    const { data: project } = await supabase
      .from(T.projects)
      .select('global_style_settings')
      .eq('id', product.project_id)
      .single()
    geminiApiKey = resolveGoogleApiKey(project?.global_style_settings as GlobalStyleSettings | null)
  }

  const resolvedModel = model || scene.generation_model || 'veo3'
  const isLtx = isLtxModel(resolvedModel)
  const isVeo = isVeoModel(resolvedModel)

  // Get signed URLs for start/end frame images
  const frameRefs: FrameRefs = {}
  const videoSettings: SceneVideoSettings = {
    resolution: scene.video_resolution,
    aspectRatio: scene.video_aspect_ratio,
    durationSeconds: scene.video_duration_seconds,
    fps: scene.video_fps,
    generateAudio: scene.video_generate_audio,
  }

  videoSettings.durationSeconds = normalizeDurationValue(
    resolvedModel,
    videoSettings.durationSeconds,
    videoSettings.resolution,
    !!scene.start_frame_image_id,
    !!scene.end_frame_image_id
  )

  const [startFrameRef, endFrameRef] = await Promise.all([
    scene.start_frame_image_id ? createFrameRef(supabase, scene.start_frame_image_id) : Promise.resolve(undefined),
    scene.end_frame_image_id && !isLtx
      ? createFrameRef(supabase, scene.end_frame_image_id)
      : Promise.resolve(undefined),
  ])

  if (startFrameRef) frameRefs.start = startFrameRef
  if (endFrameRef) frameRefs.end = endFrameRef

  // Generate video
  let result: VideoGenerationResult

  if (isVeo) {
    result = await generateWithVeo3(scene.motion_prompt, frameRefs, videoSettings, geminiApiKey)
  } else if (isLtx) {
    result = await generateWithLtx(scene.motion_prompt, frameRefs, videoSettings)
  } else {
    throw new Error(`Unsupported model: ${resolvedModel}`)
  }

  // Upload to storage
  const slug = slugify(scene.motion_prompt)
  const timestamp = Date.now()
  const fileName = `video-${slug}-${timestamp}.${result.extension}`
  const storagePath = `products/${productId}/scenes/${sceneId}/${fileName}`

  const { error: uploadErr } = await supabase.storage
    .from('generated-videos')
    .upload(storagePath, result.buffer, { contentType: result.mimeType })

  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

  // Extract and upload thumbnail
  let thumbStoragePath: string | null = null
  try {
    const thumb = await extractVideoThumbnail(result.buffer)
    thumbStoragePath = buildThumbnailPath(storagePath, thumb.extension)

    const { error: thumbUploadErr } = await supabase.storage
      .from('generated-videos')
      .upload(thumbStoragePath, thumb.buffer, { contentType: thumb.mimeType })

    if (thumbUploadErr) {
      console.warn(`Video thumbnail upload failed: ${thumbUploadErr.message}`)
      thumbStoragePath = null
    }
  } catch (err) {
    console.warn('Video thumbnail extraction failed:', err)
    thumbStoragePath = null
  }

  // Insert record
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
      scene_id: sceneId,
      scene_name: scene.title || null,
      approval_status: 'pending',
    })
    .select()
    .single()

  if (insertErr) throw new Error(insertErr.message)
  return record
}

// ---------------------------------------------------------------------------
// Video generation integrations
// ---------------------------------------------------------------------------

async function generateWithVeo3(
  prompt: string,
  frameRefs: { start?: FrameRef; end?: FrameRef },
  settings: SceneVideoSettings,
  apiKeyOverride?: string | null
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const apiKey = apiKeyOverride || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Google AI API key not configured')

  const defaultModel = 'veo-3.1-generate-preview'
  const configuredModel = process.env.VEO_MODEL?.trim()
  const model = configuredModel || defaultModel
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
  const instance: Record<string, unknown> = { prompt }
  const instances: Array<Record<string, unknown>> = [instance]
  const parameters: Record<string, unknown> = {}

  if (frameRefs.start?.url) {
    const imgResp = await fetch(frameRefs.start.url)
    if (!imgResp.ok) throw new Error(`Failed to fetch start frame (${imgResp.status})`)
    const imgBuf = Buffer.from(await imgResp.arrayBuffer())
    const mimeType = frameRefs.start.mimeType || imgResp.headers.get('content-type') || 'image/png'
    instance.image = {
      mimeType,
      bytesBase64Encoded: imgBuf.toString('base64'),
    }
  }

  if (frameRefs.end?.url) {
    if (!frameRefs.start?.url) {
      console.warn('[Veo] Ignoring end frame because no start frame was provided.')
    } else {
      const imgResp = await fetch(frameRefs.end.url)
      if (!imgResp.ok) throw new Error(`Failed to fetch end frame (${imgResp.status})`)
      const imgBuf = Buffer.from(await imgResp.arrayBuffer())
      const mimeType = frameRefs.end.mimeType || imgResp.headers.get('content-type') || 'image/png'
      instance.lastFrame = {
        mimeType,
        bytesBase64Encoded: imgBuf.toString('base64'),
      }
    }
  }

  const aspectRatio = settings.aspectRatio || process.env.VEO_ASPECT_RATIO
  if (aspectRatio) parameters.aspectRatio = aspectRatio
  const resolution = settings.resolution || process.env.VEO_RESOLUTION
  if (resolution) parameters.resolution = resolution
  const durationSource = settings.durationSeconds ?? process.env.VEO_DURATION_SECONDS
  const durationSeconds = normalizeDurationValue(
    model,
    durationSource,
    resolution,
    !!frameRefs.start,
    !!frameRefs.end
  )
  const generateAudio = typeof settings.generateAudio === 'boolean' ? settings.generateAudio : null
  const veoSupportsAudio = process.env.VEO_SUPPORTS_AUDIO === 'true'
  if (veoSupportsAudio && generateAudio !== null) parameters.generateAudio = generateAudio
  if (durationSeconds) parameters.durationSeconds = durationSeconds
  const shouldLog = process.env.VEO_DEBUG === 'true' || process.env.NODE_ENV !== 'production'
  if (shouldLog) {
    console.log('[Veo] parameters', {
      model,
      durationSeconds,
      resolution: parameters.resolution,
      aspectRatio: parameters.aspectRatio,
      generateAudio: parameters.generateAudio,
    })
  }

  const payload: Record<string, unknown> = { instances }
  if (Object.keys(parameters).length) payload.parameters = parameters

  const response = await fetch(
    `${baseUrl}/models/${model}:predictLongRunning`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    }
  )

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`Veo API error: ${response.status} ${errBody}`)
  }

  let operation = await response.json()
  const operationName = operation?.name
  if (!operationName) throw new Error('No operation name in Veo response')

  const pollIntervalMs = Number(process.env.VEO_POLL_INTERVAL_MS || 10000)
  const timeoutMs = Number(process.env.VEO_POLL_TIMEOUT_MS || 600000)
  const startedAt = Date.now()

  while (!operation?.done) {
    if (Date.now() - startedAt > timeoutMs) {
      const timeoutSeconds = Math.round(timeoutMs / 1000)
      throw new Error(`Veo generation timed out after ${timeoutSeconds}s`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const statusResp = await fetch(`${baseUrl}/${operationName}`, {
      headers: { 'x-goog-api-key': apiKey },
    })
    if (!statusResp.ok) {
      const errBody = await statusResp.text()
      throw new Error(`Veo operation error: ${statusResp.status} ${errBody}`)
    }
    operation = await statusResp.json()
  }

  if (operation?.error) {
    const message =
      operation.error?.message ||
      (typeof operation.error === 'string' ? operation.error : JSON.stringify(operation.error))
    throw new Error(`Veo operation error: ${message}`)
  }

  const videoUri =
    operation?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
  if (!videoUri) throw new Error('No video URI in Veo response')

  const videoResp = await fetch(videoUri, {
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'follow',
  })
  if (!videoResp.ok) throw new Error(`Failed to download video (${videoResp.status})`)
  const videoBuffer = Buffer.from(await videoResp.arrayBuffer())
  const mimeType = (videoResp.headers.get('content-type') || 'video/mp4').split(';')[0]
  const extension = mimeType.includes('/') ? mimeType.split('/')[1] : 'mp4'

  return {
    buffer: videoBuffer,
    mimeType,
    extension: extension || 'mp4',
  }
}

async function generateWithLtx(
  prompt: string,
  frameRefs: { start?: FrameRef; end?: FrameRef },
  settings: SceneVideoSettings
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const apiKey = process.env.LTX_API_KEY
  if (!apiKey) throw new Error('LTX_API_KEY not configured')

  const baseUrl = (process.env.LTX_API_BASE_URL || 'https://api.ltx.video/v1').replace(/\/$/, '')
  const model = process.env.LTX_MODEL || 'ltx-2-pro'
  const duration = typeof settings.durationSeconds === 'number' && settings.durationSeconds > 0
    ? settings.durationSeconds
    : Number(process.env.LTX_DURATION ?? '8')
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 8
  const resolution = settings.resolution || process.env.LTX_RESOLUTION || '1920x1080'
  const fps = typeof settings.fps === 'number' && settings.fps > 0 ? settings.fps : null
  const generateAudio = typeof settings.generateAudio === 'boolean' ? settings.generateAudio : null

  const payload: Record<string, unknown> = {
    prompt,
    model,
    duration: safeDuration,
    resolution,
  }
  if (fps) payload.fps = fps
  if (generateAudio !== null) payload.generate_audio = generateAudio

  const endpoint = frameRefs.start?.url ? 'image-to-video' : 'text-to-video'
  if (frameRefs.start?.url) payload.image_uri = frameRefs.start.url

  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`LTX API error: ${response.status} ${errBody}`)
  }

  const videoBuffer = Buffer.from(await response.arrayBuffer())
  const mimeType = (response.headers.get('content-type') || 'video/mp4').split(';')[0]
  const extension = mimeType.includes('/') ? mimeType.split('/')[1] : 'mp4'

  return { buffer: videoBuffer, mimeType, extension: extension || 'mp4' }
}
