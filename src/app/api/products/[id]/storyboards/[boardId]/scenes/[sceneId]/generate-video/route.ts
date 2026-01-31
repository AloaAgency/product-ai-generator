import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processGenerationJob } from '@/lib/generation-worker'

export const runtime = 'nodejs'
export const maxDuration = 600
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  try {
    const { id: productId, sceneId } = await params
    const body = await request.json()
    const supabase = createServiceClient()

    const { data: scene, error: sceneError } = await supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('id', sceneId)
      .single()

    if (sceneError || !scene) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    }
    if (!scene.motion_prompt) {
      return NextResponse.json({ error: 'Scene has no motion prompt' }, { status: 400 })
    }

    const model: string = body.model || scene.generation_model || 'veo3'
    const isLtx = model.toLowerCase().startsWith('ltx')
    const resolution = scene.video_resolution
      || (isLtx ? process.env.LTX_RESOLUTION : process.env.VEO_RESOLUTION)
      || (isLtx ? '1920x1080' : '1080p')
    const aspectRatio = scene.video_aspect_ratio || process.env.VEO_ASPECT_RATIO || '16:9'
    const finalPrompt = scene.motion_prompt || scene.title || 'Video generation'

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

    if (jobError || !job) {
      return NextResponse.json({ error: 'Failed to create video job' }, { status: 500 })
    }

    const shouldRunInline =
      process.env.INLINE_GENERATION === 'true' || process.env.NODE_ENV === 'development'

    if (shouldRunInline) {
      void processGenerationJob(job.id)
    } else {
      const cronSecret = process.env.CRON_SECRET
      if (cronSecret) {
        const url = new URL('/api/worker/generate', request.url)
        url.searchParams.set('jobId', job.id)
        void (async () => {
          try {
            const res = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${cronSecret}`,
              },
            })
            console.log('[GenerateVideo] Worker kick', {
              jobId: job.id,
              status: res.status,
            })
          } catch (err) {
            console.warn('[GenerateVideo] Worker kick failed', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    console.error('[GenerateVideo] Error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    const status = message === 'Scene not found' ? 404
      : message === 'Scene has no motion prompt' ? 400
      : message.startsWith('Unsupported model') ? 400
      : 500
    return NextResponse.json({ error: message }, { status })
  }
}
