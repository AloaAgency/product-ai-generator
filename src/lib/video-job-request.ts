import type { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

type ServiceClient = ReturnType<typeof createServiceClient>

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

const DEFAULT_WORKER_KICK_TIMEOUT_MS = 15_000

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
  const timeoutMs = Number(env.WORKER_KICK_TIMEOUT_MS)
  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_WORKER_KICK_TIMEOUT_MS

  const url = new URL('/api/worker/generate', requestUrl)
  url.searchParams.set('jobId', jobId)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) url.searchParams.set(key, value)
    }
  }

  void (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: controller.signal,
      })
      console.log(`${label} Worker kick`, { jobId, status: res.status })
    } catch (err) {
      console.warn(`${label} Worker kick failed`, {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      clearTimeout(timeout)
    }
  })()
}

type CreateSceneVideoJobResult =
  | { job: Record<string, unknown>; error: null }
  | { job: null; error: string }

/**
 * Fetches a storyboard scene, validates it, and inserts a video generation job.
 * Returns the created job on success or an error string on failure.
 * Used by both the standalone scenes route and the storyboard-nested scenes route.
 */
export async function createSceneVideoJob(
  supabase: ServiceClient,
  productId: string,
  sceneId: string,
  requestedModel?: string | null
): Promise<CreateSceneVideoJobResult> {
  const { data: scene, error: sceneError } = await supabase
    .from(T.storyboard_scenes)
    .select('*')
    .eq('id', sceneId)
    .single()

  if (sceneError || !scene) return { job: null, error: 'Scene not found' }
  if (!scene.motion_prompt) return { job: null, error: 'Scene has no motion prompt' }

  const { model, resolution, aspectRatio, finalPrompt } = buildVideoJobRequest(scene, requestedModel)

  const { data: job, error: jobError } = await supabase
    .from(T.generation_jobs)
    .insert({
      product_id: productId,
      prompt_template_id: null,
      reference_set_id: null,
      final_prompt: finalPrompt,
      variation_count: 1,
      resolution,
      aspect_ratio: aspectRatio,
      status: 'pending',
      completed_count: 0,
      failed_count: 0,
      generation_model: model,
      job_type: 'video',
      scene_id: sceneId,
    })
    .select()
    .single()

  if (jobError || !job) return { job: null, error: 'Failed to create video job' }
  return { job: job as Record<string, unknown>, error: null }
}
