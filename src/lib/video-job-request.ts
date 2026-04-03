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

/**
 * Fire-and-forget: kicks the worker for a specific job via the generate endpoint.
 * Logs success/failure without surfacing errors to the caller.
 *
 * @param jobId       The generation job to process
 * @param requestUrl  The originating request URL (used to derive the worker base URL)
 * @param label       Log prefix, e.g. '[GenerateVideo]'
 * @param extraParams Optional query params to forward (e.g. batch size, parallelism)
 */
export function kickWorkerForJob(
  jobId: string,
  requestUrl: string,
  label: string,
  extraParams?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): void {
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return

  const url = new URL('/api/worker/generate', requestUrl)
  url.searchParams.set('jobId', jobId)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) url.searchParams.set(key, value)
    }
  }

  void (async () => {
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      console.log(`${label} Worker kick`, { jobId, status: res.status })
    } catch (err) {
      console.warn(`${label} Worker kick failed`, {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}
