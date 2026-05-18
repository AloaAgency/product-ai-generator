import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processGenerationJob } from '@/lib/generation-worker'
import { logError } from '@/lib/error-logger'
import {
  createSceneVideoJob,
  kickWorkerForJob,
  shouldRunVideoGenerationInline,
} from '@/lib/video-job-request'

export const runtime = 'nodejs'
export const maxDuration = 600
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  const { id: productId, sceneId } = await params
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
        console.error('[GenerateVideo] Inline job failed:', err)
        await logError({
          productId,
          errorMessage: message,
          errorSource: 'api/products/storyboards/scenes/generate-video:inline',
          errorContext: { sceneId, jobId: job!.id as string },
        })
      })
    } else {
      kickWorkerForJob(job!.id as string, request.url, '[GenerateVideo]')
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    console.error('[GenerateVideo] Error:', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/products/storyboards/scenes/generate-video',
      errorContext: { sceneId },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
