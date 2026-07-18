import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processGenerationJob } from '@/lib/generation-worker'
import { logError } from '@/lib/error-logger'
import { logger } from '@/lib/server-logger'

export type ServiceClient = ReturnType<typeof createServiceClient>

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

  // This fetch delivers CRON_SECRET as a bearer token, so the target origin
  // must not be attacker-influenced. requestUrl's host ultimately comes from
  // the incoming Host / X-Forwarded-Host headers; on platforms that don't
  // strictly bind those to the deployment (Vercel does, a bare reverse proxy
  // may not), a forged header would make this kick deliver the secret to a
  // foreign origin. Setting WORKER_BASE_URL (e.g. https://app.example.com)
  // pins the target; the request URL remains the fallback so local dev and
  // Host-validating platforms keep working with no extra configuration.
  let url: URL
  try {
    url = new URL('/api/worker/generate', env.WORKER_BASE_URL || requestUrl)
  } catch (err) {
    // Fire-and-forget contract: never throw into the calling route.
    logger.warn(`${label} Worker kick skipped — invalid worker base URL`, {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
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
      logger.debug(`${label} Worker kick`, { jobId, status: res.status })
    } catch (err) {
      logger.warn(`${label} Worker kick failed`, {
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
  // Scope by product_id so a caller cannot trigger video generation for a scene
  // that belongs to a different product by supplying a foreign sceneId.
  const { data: scene, error: sceneError } = await supabase
    .from(T.storyboard_scenes)
    .select('*')
    .eq('id', sceneId)
    .eq('product_id', productId)
    .single()

  if (sceneError || !scene) return { job: null, error: 'Scene not found' }
  if (!scene.motion_prompt) return { job: null, error: 'Scene has no motion prompt' }

  const { model, resolution, aspectRatio, finalPrompt } = buildVideoJobRequest(scene, requestedModel)

  const { data: job, error: jobError } = await supabase
    .from(T.generation_jobs)
    .insert({
      product_id: productId,
      prompt_template_id: null,
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

/**
 * Shared POST handler for both scene generate-video routes:
 *   /api/products/[id]/scenes/[sceneId]/generate-video
 *   /api/products/[id]/storyboards/[boardId]/scenes/[sceneId]/generate-video
 *
 * The only difference between those routes is the errorSource string logged on failure.
 */
export async function handleSceneGenerateVideoPost(
  request: NextRequest,
  productId: string,
  sceneId: string,
  errorSource: string
): Promise<NextResponse> {
  try {
    let body: { model?: string } = {}
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const { job, error } = await createSceneVideoJob(supabase, productId, sceneId, body.model)

    if (error === 'Scene not found') return NextResponse.json({ error }, { status: 404 })
    if (error) return NextResponse.json({ error }, { status: 400 })

    if (shouldRunVideoGenerationInline()) {
      void processGenerationJob(job!.id as string).catch(async (err) => {
        const message = err instanceof Error ? err.message : 'Video generation failed'
        logger.error('[GenerateVideo] Inline job failed:', err)
        await logError({
          productId,
          errorMessage: message,
          errorSource: `${errorSource}:inline`,
          errorContext: { sceneId, jobId: job!.id as string },
        })
      })
    } else {
      kickWorkerForJob(job!.id as string, request.url, '[GenerateVideo]')
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    logger.error('[GenerateVideo] Error:', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource,
      errorContext: { sceneId },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
