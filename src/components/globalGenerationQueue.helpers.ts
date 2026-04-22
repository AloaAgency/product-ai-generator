import type { GenerationJob } from '../lib/types'

export const POLL_MS = 5000

export const isActiveStatus = (status: string) => status === 'pending' || status === 'running'

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

export const deriveGenerationQueueState = (generationJobs: GenerationJob[]) => {
  const activeJobs = generationJobs.filter((job) => isActiveStatus(job.status))
  const failedJobs = generationJobs
    .filter((job) => job.status === 'failed')
    .sort((a, b) => {
      const aTs = getSortableTimestamp(a.completed_at || a.created_at)
      const bTs = getSortableTimestamp(b.completed_at || b.created_at)
      return bTs - aTs
    })

  const pendingCount = activeJobs.filter((job) => job.status === 'pending').length
  const runningCount = activeJobs.filter((job) => job.status === 'running').length
  const failedCount = failedJobs.length
  const recentFailedJobs = failedJobs.slice(0, 3)
  const totals = activeJobs.reduce(
    (acc, job) => ({
      totalVariations: acc.totalVariations + (job.variation_count || 0),
      totalCompleted: acc.totalCompleted + (job.completed_count || 0),
    }),
    { totalVariations: 0, totalCompleted: 0 }
  )

  return {
    activeJobs,
    failedJobs,
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

export const shouldPollGenerationQueue = ({
  hasActiveJobs,
  isDocumentVisible,
  isPolling,
  timeSinceLastPollMs,
  minIntervalMs = POLL_MS,
}: {
  hasActiveJobs: boolean
  isDocumentVisible: boolean
  isPolling: boolean
  timeSinceLastPollMs: number
  minIntervalMs?: number
}) => {
  if (!hasActiveJobs || !isDocumentVisible || isPolling) return false
  return timeSinceLastPollMs >= minIntervalMs
}
