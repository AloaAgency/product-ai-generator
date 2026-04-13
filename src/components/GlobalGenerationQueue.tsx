'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useAppStore } from '@/lib/store'
import { AlertTriangle, ChevronDown, ChevronUp, Inbox, Loader2 } from 'lucide-react'
import {
  deriveGenerationQueueState,
  getFailureTimestamp,
  getGenerationJobProgress,
  POLL_MS,
} from './globalGenerationQueue.helpers'
import { getSafeQueueErrorMessage } from './errorDisplay.helpers'

export default function GlobalGenerationQueue({
  productId,
}: {
  productId: string
}) {
  const detailsId = useId()
  const generationJobs = useAppStore((state) => state.generationJobs)
  const loadingJobs = useAppStore((state) => state.loadingJobs)
  const fetchGenerationJobs = useAppStore((state) => state.fetchGenerationJobs)
  const clearGenerationQueue = useAppStore((state) => state.clearGenerationQueue)
  const clearGenerationFailures = useAppStore((state) => state.clearGenerationFailures)
  const devParallelGeneration = useAppStore((state) => state.devParallelGeneration)
  const setDevParallelGeneration = useAppStore((state) => state.setDevParallelGeneration)
  const [expanded, setExpanded] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearingFailures, setClearingFailures] = useState(false)
  const isPollingRef = useRef(false)

  const {
    activeJobs,
    pendingCount,
    runningCount,
    failedCount,
    recentFailedJobs,
    totals,
    overallProgress,
    hasActiveJobs,
  } = useMemo(() => deriveGenerationQueueState(generationJobs), [generationJobs])
  const showIndeterminateOverallBar = hasActiveJobs && totals.totalCompleted === 0

  useEffect(() => {
    let cancelled = false

    const runPoll = async () => {
      if (cancelled || document.visibilityState === 'hidden' || isPollingRef.current) return
      isPollingRef.current = true
      try {
        await fetchGenerationJobs(productId)
      } finally {
        isPollingRef.current = false
      }
    }

    void runPoll()
    if (!hasActiveJobs) {
      return () => {
        cancelled = true
      }
    }

    const interval = window.setInterval(() => {
      void runPoll()
    }, POLL_MS)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void runPoll()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(interval)
    }
  }, [productId, fetchGenerationJobs, hasActiveJobs])

  useEffect(() => {
    if (!hasActiveJobs) {
      setExpanded(false)
    }
  }, [hasActiveJobs])

  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  const handleToggleDevParallel = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setDevParallelGeneration(!devParallelGeneration)
  }, [devParallelGeneration, setDevParallelGeneration])

  const handleClearQueue = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (clearing) return
    const confirmed = window.confirm('Clear active generation queue? This will cancel pending and running jobs.')
    if (!confirmed) return
    try {
      setClearing(true)
      await clearGenerationQueue(productId)
    } finally {
      setClearing(false)
    }
  }, [clearGenerationQueue, clearing, productId])

  const handleClearFailures = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (clearingFailures) return
    const confirmed = window.confirm('Clear recent failed jobs from queue history?')
    if (!confirmed) return
    try {
      setClearingFailures(true)
      await clearGenerationFailures(productId)
    } finally {
      setClearingFailures(false)
    }
  }, [clearGenerationFailures, clearingFailures, productId])

  if (!hasActiveJobs) {
    return null
  }

  return (
    <section
      className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/70 backdrop-blur"
      aria-label="Generation queue"
    >
      <div className="flex w-full flex-col gap-3 px-3 py-3 sm:px-4 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={handleToggleExpanded}
          className="flex min-h-11 w-full min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/10 text-blue-400">
            {loadingJobs ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <span className="text-xs font-semibold">AI</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">Generation queue</p>
            <p className="break-words text-xs text-zinc-500" aria-live="polite">
              {loadingJobs && generationJobs.length === 0
                ? 'Checking queue...'
                : hasActiveJobs
                  ? `${pendingCount} pending · ${runningCount} running${failedCount ? ` · ${failedCount} failed` : ''}`
                  : failedCount
                    ? `No active generations · ${failedCount} failed recently`
                    : 'No active generations'}
            </p>
          </div>
        </button>
        <div className="flex w-full flex-wrap items-center gap-2 text-xs text-zinc-400 sm:w-auto sm:justify-end sm:gap-3">
          {process.env.NODE_ENV === 'development' && (
            <button
              type="button"
              className="min-h-11 whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
              onClick={handleToggleDevParallel}
            >
              Dev parallel: {devParallelGeneration ? 'On' : 'Off'}
            </button>
          )}
          {hasActiveJobs && (
            <button
              type="button"
              className="min-h-11 whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleClearQueue}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          )}
          {failedCount > 0 && (
            <button
              type="button"
              className="min-h-11 whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleClearFailures}
              disabled={clearingFailures}
            >
              {clearingFailures ? 'Clearing failures…' : 'Clear failures'}
            </button>
          )}
          <span className="min-h-11 min-w-0 content-center break-words text-left sm:text-right" aria-live="polite">
            {hasActiveJobs
              ? `${totals.totalCompleted}/${totals.totalVariations} outputs`
              : failedCount
                ? `${failedCount} failed`
                : '0 outputs'}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </div>

      <div id={detailsId} className="px-3 pb-4 sm:px-4">
        <div className="flex flex-col gap-1 text-xs text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
          <span>{overallProgress}% overall</span>
          <span>Updates every {POLL_MS / 1000}s</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          {showIndeterminateOverallBar ? (
            <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse-bar" />
          ) : (
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${overallProgress}%` }}
            />
          )}
        </div>

        {expanded && (
          <div className="mt-4 space-y-3">
            {hasActiveJobs ? (
              activeJobs.map((job) => {
                const jobProgress = getGenerationJobProgress(job)
                const showIndeterminateJobBar = job.status === 'pending' || (job.status === 'running' && (job.completed_count ?? 0) === 0)

                const unitLabel = job.job_type === 'video'
                  ? (job.variation_count === 1 ? 'video' : 'videos')
                  : (job.variation_count === 1 ? 'image' : 'images')

                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <p className="min-w-0 break-words text-sm leading-5 text-zinc-200 sm:line-clamp-2">
                        {job.final_prompt}
                      </p>
                      <span className="shrink-0 self-start rounded-full bg-zinc-800 px-2.5 py-1 text-xs font-medium capitalize text-zinc-400">
                        {job.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-col gap-1 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
                      <span className="break-words">
                        {job.completed_count} / {job.variation_count} {unitLabel}
                        {job.failed_count ? ` · ${job.failed_count} failed` : ''}
                      </span>
                      <span>{jobProgress}%</span>
                    </div>
                    {job.error_message && (
                      <p className="mt-1 break-words text-xs leading-5 text-red-400 sm:line-clamp-2">
                        {getSafeQueueErrorMessage(job.error_message)}
                      </p>
                    )}
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      {showIndeterminateJobBar ? (
                        <div className="h-full w-1/3 rounded-full bg-blue-500/80 animate-pulse-bar" />
                      ) : (
                        <div
                          className="h-full rounded-full bg-blue-500/80 transition-all duration-500"
                          style={{ width: `${jobProgress}%` }}
                        />
                      )}
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
                  <Inbox className="h-5 w-5" />
                </div>
                <p className="mt-3 text-sm font-medium text-zinc-300">Queue is idle</p>
                <p className="mt-1 text-xs text-zinc-500">
                  New generations will appear here automatically.
                </p>
              </div>
            )}
            {recentFailedJobs.length > 0 && (
              <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-red-950/60 text-red-300">
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-red-300">Recent failures</p>
                    <p className="text-xs text-red-300/70">Latest failed jobs are kept here until cleared.</p>
                  </div>
                </div>
                <div className="mt-2 space-y-2">
                  {recentFailedJobs.map((job) => (
                    <div key={job.id} className="rounded-lg border border-red-900/30 bg-black/10 px-3 py-2 text-xs text-red-200">
                      <p className="break-words leading-5 sm:line-clamp-2">{job.final_prompt}</p>
                      <p className="mt-1 text-xs text-red-300/70">
                        Failed at {getFailureTimestamp(job.completed_at || job.created_at) || 'Unknown'}
                      </p>
                      {job.error_message && (
                        <p className="mt-1 break-words text-xs leading-5 text-red-300/80 sm:line-clamp-3">
                          {getSafeQueueErrorMessage(job.error_message)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
