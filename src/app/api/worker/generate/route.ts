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
  const timeBudgetMs = Number(url.searchParams.get('budget') || process.env.GENERATION_TIME_BUDGET_MS || 50000)

  try {
    if (jobId) {
      const result = await processGenerationJob(jobId, { batchSize, parallelism, timeBudgetMs })
      return NextResponse.json({ processed: 1, results: [result] })
    }

    const { data: jobs, error } = await supabase
      .from(T.generation_jobs)
      .select('id,status,created_at')
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: true })
      .limit(Math.max(1, jobBatchSize))

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ processed: 0, results: [] })
    }

    const results = []
    for (const job of jobs) {
      const result = await processGenerationJob(job.id, { batchSize, parallelism, timeBudgetMs })
      results.push(result)
    }
    return NextResponse.json({ processed: results.length, results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Worker error' },
      { status: 500 }
    )
  }
}
