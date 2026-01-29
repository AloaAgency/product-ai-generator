import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { slugify } from '@/lib/image-utils'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

type FrameRef = { url: string; mimeType: string }

export async function generateSceneVideo(productId: string, sceneId: string, model: string) {
  const supabase = createServiceClient()

  // Fetch the scene
  const { data: scene, error: sceneErr } = await supabase
    .from(T.storyboard_scenes)
    .select('*')
    .eq('id', sceneId)
    .single()

  if (sceneErr || !scene) throw new Error('Scene not found')
  if (!scene.motion_prompt) throw new Error('Scene has no motion prompt')

  // Get signed URLs for start/end frame images
  const frameRefs: { start?: FrameRef; end?: FrameRef } = {}

  if (scene.start_frame_image_id) {
    const { data: startImg } = await supabase
      .from(T.generated_images)
      .select('storage_path, mime_type')
      .eq('id', scene.start_frame_image_id)
      .single()

    if (startImg?.storage_path) {
      const { data: signed } = await supabase.storage
        .from('generated-images')
        .createSignedUrl(startImg.storage_path, SIGNED_URL_TTL_SECONDS)
      if (signed?.signedUrl) {
        frameRefs.start = { url: signed.signedUrl, mimeType: startImg.mime_type || 'image/png' }
      }
    }
  }

  if (scene.end_frame_image_id) {
    const { data: endImg } = await supabase
      .from(T.generated_images)
      .select('storage_path, mime_type')
      .eq('id', scene.end_frame_image_id)
      .single()

    if (endImg?.storage_path) {
      const { data: signed } = await supabase.storage
        .from('generated-images')
        .createSignedUrl(endImg.storage_path, SIGNED_URL_TTL_SECONDS)
      if (signed?.signedUrl) {
        frameRefs.end = { url: signed.signedUrl, mimeType: endImg.mime_type || 'image/png' }
      }
    }
  }

  // Generate video
  let videoBuffer: Buffer
  let mimeType: string
  let extension: string

  if (model === 'veo3') {
    const result = await generateWithVeo3(scene.motion_prompt, frameRefs)
    videoBuffer = result.buffer
    mimeType = result.mimeType
    extension = result.extension
  } else if (model === 'ltx') {
    const result = await generateWithLtx(scene.motion_prompt, frameRefs)
    videoBuffer = result.buffer
    mimeType = result.mimeType
    extension = result.extension
  } else {
    throw new Error(`Unsupported model: ${model}`)
  }

  // Upload to storage
  const slug = slugify(scene.motion_prompt)
  const timestamp = Date.now()
  const fileName = `video-${slug}-${timestamp}.${extension}`
  const storagePath = `products/${productId}/scenes/${sceneId}/${fileName}`

  const { error: uploadErr } = await supabase.storage
    .from('generated-videos')
    .upload(storagePath, videoBuffer, { contentType: mimeType })

  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

  // Insert record
  const { data: record, error: insertErr } = await supabase
    .from(T.generated_images)
    .insert({
      job_id: null,
      variation_number: 1,
      storage_path: storagePath,
      mime_type: mimeType,
      file_size: videoBuffer.length,
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
  frameRefs: { start?: FrameRef; end?: FrameRef }
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured')

  const model = process.env.VEO_MODEL || 'veo-3.1-generate-preview'
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
  const instances: Array<Record<string, unknown>> = [{ prompt }]
  const parameters: Record<string, unknown> = {}

  if (frameRefs.start?.url) {
    const imgResp = await fetch(frameRefs.start.url)
    if (!imgResp.ok) throw new Error(`Failed to fetch start frame (${imgResp.status})`)
    const imgBuf = Buffer.from(await imgResp.arrayBuffer())
    const mimeType = frameRefs.start.mimeType || imgResp.headers.get('content-type') || 'image/png'
    instances[0].image = {
      inlineData: {
        mimeType,
        data: imgBuf.toString('base64'),
      },
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
      parameters.lastFrame = {
        inlineData: {
          mimeType,
          data: imgBuf.toString('base64'),
        },
      }
    }
  }

  const aspectRatio = process.env.VEO_ASPECT_RATIO
  if (aspectRatio) parameters.aspectRatio = aspectRatio
  const resolution = process.env.VEO_RESOLUTION
  if (resolution) parameters.resolution = resolution

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
  const timeoutMs = Number(process.env.VEO_POLL_TIMEOUT_MS || 240000)
  const startedAt = Date.now()

  while (!operation?.done) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Veo generation timed out')
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
  frameRefs: { start?: FrameRef; end?: FrameRef }
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const apiKey = process.env.LTX_API_KEY
  if (!apiKey) throw new Error('LTX_API_KEY not configured')

  const baseUrl = (process.env.LTX_API_BASE_URL || 'https://api.ltx.video/v1').replace(/\/$/, '')
  const model = process.env.LTX_MODEL || 'ltx-2-pro'
  const duration = Number(process.env.LTX_DURATION ?? '8')
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 8
  const resolution = process.env.LTX_RESOLUTION || '1920x1080'

  const payload: Record<string, unknown> = {
    prompt,
    model,
    duration: safeDuration,
    resolution,
  }

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
