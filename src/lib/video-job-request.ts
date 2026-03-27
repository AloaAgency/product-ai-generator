type SceneVideoJobInput = {
  motion_prompt: string | null
  title: string | null
  generation_model: string | null
  video_resolution: string | null
  video_aspect_ratio: string | null
}

type VideoJobRequest = {
  model: string
  resolution: string
  aspectRatio: string
  finalPrompt: string
}

export function buildVideoJobRequest(
  scene: SceneVideoJobInput,
  requestedModel?: string | null,
  env: NodeJS.ProcessEnv = process.env
): VideoJobRequest {
  const model = requestedModel || scene.generation_model || 'veo3'
  const isLtx = model.toLowerCase().startsWith('ltx')

  return {
    model,
    resolution: scene.video_resolution
      || (isLtx ? env.LTX_RESOLUTION : env.VEO_RESOLUTION)
      || (isLtx ? '1920x1080' : '1080p'),
    aspectRatio: scene.video_aspect_ratio || env.VEO_ASPECT_RATIO || '16:9',
    finalPrompt: scene.motion_prompt || scene.title || 'Video generation',
  }
}

export function shouldRunVideoGenerationInline(env: NodeJS.ProcessEnv = process.env) {
  return env.INLINE_GENERATION === 'true' || env.NODE_ENV === 'development'
}
