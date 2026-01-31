import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processGenerationJob } from '@/lib/generation-worker'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const maxDuration = 800
export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest) {
  const vercelCron = request.headers.get('x-vercel-cron')
  if (vercelCron) return true
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const headerSecret = request.headers.get('x-cron-secret')
  if (headerSecret && headerSecret === secret) return true
  const auth = request.headers.get('authorization') || ''
  if (auth.startsWith('Bearer ') && auth.slice(7) === secret) return true
  return false
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const url = new URL(request.url)
  const jobId = url.searchParams.get('jobId')
  const batchSize = Number(url.searchParams.get('batch') || process.env.GENERATION_BATCH_SIZE || 1)
  const parallelism = Number(url.searchParams.get('parallel') || process.env.GENERATION_PARALLELISM || 1)
  const jobBatchSize = Number(url.searchParams.get('jobs') || process.env.GENERATION_JOB_BATCH_SIZE || 1)
  const defaultJobConcurrency = Number(process.env.GENERATION_JOB_CONCURRENCY || 1)
  const imageJobConcurrency = Number(url.searchParams.get('imageJobs') || process.env.IMAGE_JOB_CONCURRENCY || defaultJobConcurrency || 1)
  const videoJobConcurrency = Number(url.searchParams.get('videoJobs') || process.env.VIDEO_JOB_CONCURRENCY || defaultJobConcurrency || 1)
  const timeBudgetMs = Number(url.searchParams.get('budget') || process.env.GENERATION_TIME_BUDGET_MS || 50000)

  try {
    console.log('[Worker] Trigger', {
      jobId: jobId || null,
      batchSize,
      parallelism,
      jobBatchSize,
      imageJobConcurrency,
      videoJobConcurrency,
      timeBudgetMs,
    })
    if (jobId) {
      const result = await processGenerationJob(jobId, { batchSize, parallelism, timeBudgetMs })
      return NextResponse.json({ processed: 1, results: [result] })
    }

    const { data: jobs, error } = await supabase
      .from(T.generation_jobs)
      .select('id,status,created_at,job_type')
      .in('status', ['pending', 'running'])
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
      const results = []
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
    console.warn('[Worker] Error', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Worker error' },
      { status: 500 }
    )
  }
}
