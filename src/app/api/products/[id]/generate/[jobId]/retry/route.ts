import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processGenerationJob } from '@/lib/generation-worker'
import { T } from '@/lib/db-tables'

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

    const shouldRunInline =
      process.env.INLINE_GENERATION === 'true' || process.env.NODE_ENV === 'development'

    if (shouldRunInline) {
      void processGenerationJob(jobId)
    } else {
      const cronSecret = process.env.CRON_SECRET
      if (cronSecret) {
        const url = new URL('/api/worker/generate', request.url)
        url.searchParams.set('jobId', jobId)
        void (async () => {
          try {
            const res = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${cronSecret}`,
              },
            })
            console.log('[RetryGeneration] Worker kick', {
              jobId,
              status: res.status,
            })
          } catch (err) {
            console.warn('[RetryGeneration] Worker kick failed', {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
    }

    return NextResponse.json({ job: updated }, { status: 200 })
  } catch (err) {
    console.error('[RetryGeneration] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
