import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processGenerationJob } from '@/lib/generation-worker'
import { logError } from '@/lib/error-logger'
import { T } from '@/lib/db-tables'
import { kickWorkerForJob, shouldRunVideoGenerationInline } from '@/lib/video-job-request'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  try {
    const { id: productId, jobId } = await params
    const supabase = createServiceClient()

    const { data: job, error: jobError } = await supabase
      .from(T.generation_jobs)
      .select('*')
      .eq('id', jobId)
      .eq('product_id', productId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const canRetry = job.status === 'failed' || (job.completed_count === 0 && (job.failed_count ?? 0) > 0)
    if (!canRetry) {
      return NextResponse.json({ error: 'Only failed jobs can be retried' }, { status: 400 })
    }

    const { data: updated, error: updateError } = await supabase
      .from(T.generation_jobs)
      .update({
        status: 'pending',
        completed_count: 0,
        failed_count: 0,
        error_message: null,
        started_at: null,
        completed_at: null,
      })
      .eq('id', jobId)
      .in('status', ['failed', 'completed'])
      .select()
      .single()

    if (updateError || !updated) {
      return NextResponse.json({ error: 'Failed to retry job' }, { status: 500 })
    }

    if (shouldRunVideoGenerationInline()) {
      void processGenerationJob(jobId).catch(async (err) => {
        const message = err instanceof Error ? err.message : 'Inline generation job failed'
        console.error('[RetryGeneration] Inline job failed:', err)
        await logError({
          productId,
          errorMessage: message,
          errorSource: 'api/products/generate/retry:inline',
          errorContext: { jobId },
        })
      })
    } else {
      kickWorkerForJob(jobId, request.url, '[RetryGeneration]')
    }

    return NextResponse.json({ job: updated }, { status: 200 })
  } catch (err) {
    console.error('[RetryGeneration] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
