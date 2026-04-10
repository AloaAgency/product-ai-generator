import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { processGenerationJob } from '@/lib/generation-worker'
import { logError } from '@/lib/error-logger'
import { T } from '@/lib/db-tables'
import {
  isValidGenerationJobId,
  MAX_GENERATION_BATCH_SIZE,
  MAX_GENERATION_JOB_BATCH_SIZE,
  MAX_GENERATION_JOB_CONCURRENCY,
  MAX_GENERATION_PARALLELISM,
  parseWorkerPositiveInteger,
  sanitizeWorkerErrorMessage,
} from '@/lib/generation-worker-guards'

export const runtime = 'nodejs'
export const maxDuration = 800
export const dynamic = 'force-dynamic'

/** Compare two strings in constant time to mitigate timing attacks. */
function secretsEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[Worker] CRON_SECRET is not set — all requests denied')
    return false
  }
  const headerSecret = request.headers.get('x-cron-secret') ?? ''
  const auth = request.headers.get('authorization') ?? ''
  const bearerSecret = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  return (headerSecret.length > 0 && secretsEqual(headerSecret, secret)) ||
    (bearerSecret.length > 0 && secretsEqual(bearerSecret, secret))
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const url = new URL(request.url)
  const jobId = url.searchParams.get('jobId')
  const batchSize = parseWorkerPositiveInteger(
    url.searchParams.get('batch') || process.env.GENERATION_BATCH_SIZE,
    1,
    { max: MAX_GENERATION_BATCH_SIZE }
  )
  const parallelism = parseWorkerPositiveInteger(
    url.searchParams.get('parallel') || process.env.GENERATION_PARALLELISM,
    1,
    { max: MAX_GENERATION_PARALLELISM }
  )
  const jobBatchSize = parseWorkerPositiveInteger(
    url.searchParams.get('jobs') || process.env.GENERATION_JOB_BATCH_SIZE,
    1,
    { max: MAX_GENERATION_JOB_BATCH_SIZE }
  )
  const defaultJobConcurrency = parseWorkerPositiveInteger(
    process.env.GENERATION_JOB_CONCURRENCY,
    1,
    { max: MAX_GENERATION_JOB_CONCURRENCY }
  )
  const imageJobConcurrency = parseWorkerPositiveInteger(
    url.searchParams.get('imageJobs') || process.env.IMAGE_JOB_CONCURRENCY,
    defaultJobConcurrency,
    { max: MAX_GENERATION_JOB_CONCURRENCY }
  )
  const videoJobConcurrency = parseWorkerPositiveInteger(
    url.searchParams.get('videoJobs') || process.env.VIDEO_JOB_CONCURRENCY,
    defaultJobConcurrency,
    { max: MAX_GENERATION_JOB_CONCURRENCY }
  )
  const timeBudgetMs = parseWorkerPositiveInteger(
    url.searchParams.get('budget') || process.env.GENERATION_TIME_BUDGET_MS,
    50000,
    { max: maxDuration * 1000 }
  )
  const staleRunningMsRaw = Number(process.env.GENERATION_RUNNING_STALE_MS)
  const staleRunningMs = Number.isFinite(staleRunningMsRaw) && staleRunningMsRaw > 0
    ? staleRunningMsRaw
    : 15 * 60 * 1000

  try {
    if (jobId && !isValidGenerationJobId(jobId)) {
      return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 })
    }

    console.log('[Worker] Trigger', {
      jobId: jobId || null,
      batchSize,
      parallelism,
      jobBatchSize,
      imageJobConcurrency,
      videoJobConcurrency,
      timeBudgetMs,
      staleRunningMs,
    })
    if (jobId) {
      const result = await processGenerationJob(jobId, { batchSize, parallelism, timeBudgetMs })
      return NextResponse.json({ processed: 1, results: [result] })
    }

    // Re-queue stale running jobs in case a previous worker invocation crashed.
    const staleCutoff = new Date(Date.now() - staleRunningMs).toISOString()
    const { data: staleJobs, error: staleError } = await supabase
      .from(T.generation_jobs)
      .update({ status: 'pending' })
      .eq('status', 'running')
      .lt('started_at', staleCutoff)
      .select('id')

    if (staleError) {
      console.warn('[Worker] Failed to requeue stale jobs', {
        error: sanitizeWorkerErrorMessage(staleError, 'Failed to requeue stale jobs'),
      })
    } else if (staleJobs && staleJobs.length > 0) {
      console.log('[Worker] Requeued stale jobs', { count: staleJobs.length })
    }

    const { data: jobs, error } = await supabase
      .from(T.generation_jobs)
      .select('id,status,created_at,job_type')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(Math.max(1, jobBatchSize))

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ processed: 0, results: [] })
    }

    const normalizedJobs = jobs.map((job) => ({
      ...job,
      job_type: job.job_type === 'video' ? 'video' : 'image',
    }))

    const runWithConcurrency = async (
      queued: typeof normalizedJobs,
      concurrency: number
    ) => {
      const limit = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1
      const results: Awaited<ReturnType<typeof processGenerationJob>>[] = []
      let index = 0
      const worker = async () => {
        while (index < queued.length) {
          const current = queued[index]
          index += 1
          const result = await processGenerationJob(current.id, { batchSize, parallelism, timeBudgetMs })
          results.push(result)
        }
      }
      const workers = Array.from({ length: Math.min(limit, queued.length) }, () => worker())
      await Promise.all(workers)
      return results
    }

    const imageJobs = normalizedJobs.filter((job) => job.job_type !== 'video')
    const videoJobs = normalizedJobs.filter((job) => job.job_type === 'video')

    const [imageResults, videoResults] = await Promise.all([
      runWithConcurrency(imageJobs, imageJobConcurrency),
      runWithConcurrency(videoJobs, videoJobConcurrency),
    ])

    const results = [...imageResults, ...videoResults]
    console.log('[Worker] Completed', { processed: results.length })
    return NextResponse.json({ processed: results.length, results })
  } catch (err) {
    const safeMessage = sanitizeWorkerErrorMessage(err)
    console.warn('[Worker] Error', { error: safeMessage })
    await logError({
      errorMessage: safeMessage,
      errorSource: 'api/worker/generate',
    })
    return NextResponse.json(
      { error: safeMessage },
      { status: 500 }
    )
  }
}
