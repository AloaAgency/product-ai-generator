import type { GenerationJob } from '../lib/types'

export const POLL_MS = 5000

export const isActiveStatus = (status: string) => status === 'pending' || status === 'running'
const MAX_RECENT_FAILURES = 3

export interface GenerationQueueTotals {
  totalVariations: number
  totalCompleted: number
}

export interface DerivedGenerationQueueState {
  activeJobs: GenerationJob[]
  pendingCount: number
  runningCount: number
  failedCount: number
  recentFailedJobs: GenerationJob[]
  totals: GenerationQueueTotals
  overallProgress: number
  hasActiveJobs: boolean
}

const getSortableTimestamp = (iso?: string | null) => {
  if (!iso) return Number.NEGATIVE_INFINITY
  const parsed = new Date(iso).getTime()
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

export const getFailureTimestamp = (iso?: string | null) => {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString()
}

const getJobProgress = (completedCount: number, variationCount: number) => {
  if (variationCount <= 0) return 0
  const ratio = completedCount / variationCount
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

const insertRecentFailure = (recentFailedJobs: GenerationJob[], job: GenerationJob) => {
  const jobTimestamp = getSortableTimestamp(job.completed_at || job.created_at)
  let insertAt = recentFailedJobs.findIndex((failedJob) => {
    const failedTimestamp = getSortableTimestamp(failedJob.completed_at || failedJob.created_at)
    return jobTimestamp > failedTimestamp
  })

  if (insertAt === -1) insertAt = recentFailedJobs.length
  if (insertAt >= MAX_RECENT_FAILURES) return

  recentFailedJobs.splice(insertAt, 0, job)
  if (recentFailedJobs.length > MAX_RECENT_FAILURES) {
    recentFailedJobs.pop()
  }
}

export const deriveGenerationQueueState = (generationJobs: GenerationJob[]): DerivedGenerationQueueState => {
  const activeJobs: GenerationJob[] = []
  const recentFailedJobs: GenerationJob[] = []
  let pendingCount = 0
  let runningCount = 0
  let failedCount = 0
  let totalVariations = 0
  let totalCompleted = 0

  for (const job of generationJobs) {
    if (isActiveStatus(job.status)) {
      activeJobs.push(job)
      totalVariations += job.variation_count || 0
      totalCompleted += job.completed_count || 0

      if (job.status === 'pending') pendingCount += 1
      else runningCount += 1
      continue
    }

    if (job.status !== 'failed') continue

    failedCount += 1
    insertRecentFailure(recentFailedJobs, job)
  }

  const totals = { totalVariations, totalCompleted }

  return {
    activeJobs,
    pendingCount,
    runningCount,
    failedCount,
    recentFailedJobs,
    totals,
    overallProgress: getJobProgress(totals.totalCompleted, totals.totalVariations),
    hasActiveJobs: activeJobs.length > 0,
  }
}

export const getGenerationJobProgress = (job: Pick<GenerationJob, 'completed_count' | 'variation_count'>) =>
  getJobProgress(job.completed_count, job.variation_count)

export const getGenerationQueueSummary = ({
  loadingJobs,
  generationJobCount,
  hasActiveJobs,
  pendingCount,
  runningCount,
  failedCount,
}: {
  loadingJobs: boolean
  generationJobCount: number
  hasActiveJobs: boolean
  pendingCount: number
  runningCount: number
  failedCount: number
}) => {
  if (loadingJobs && generationJobCount === 0) {
    return 'Checking queue...'
  }

  if (hasActiveJobs) {
    return `${pendingCount} pending · ${runningCount} running${failedCount ? ` · ${failedCount} failed` : ''}`
  }

  if (failedCount) {
    return `No active generations · ${failedCount} failed recently`
  }

  return 'No active generations'
}

export const getGenerationQueueOutputLabel = ({
  hasActiveJobs,
  failedCount,
  totals,
}: {
  hasActiveJobs: boolean
  failedCount: number
  totals: GenerationQueueTotals
}) => {
  if (hasActiveJobs) {
    return `${totals.totalCompleted}/${totals.totalVariations} outputs`
  }

  return failedCount ? `${failedCount} failed` : '0 outputs'
}

export const shouldShowIndeterminateJobProgress = (job: Pick<GenerationJob, 'status' | 'completed_count'>) =>
  job.status === 'pending' || (job.status === 'running' && (job.completed_count ?? 0) === 0)

export const getGenerationJobUnitLabel = (job: Pick<GenerationJob, 'job_type' | 'variation_count'>) => {
  const singularLabel = job.job_type === 'video' ? 'video' : 'image'
  return job.variation_count === 1 ? singularLabel : `${singularLabel}s`
}
