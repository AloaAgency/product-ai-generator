'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'

const POLL_MS = 5000

const isActiveStatus = (status: string) => status === 'pending' || status === 'running'

export default function GlobalGenerationQueue({
  productId,
}: {
  productId: string
}) {
  const { generationJobs, loadingJobs, fetchGenerationJobs, clearGenerationQueue } = useAppStore()
  const [expanded, setExpanded] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    fetchGenerationJobs(productId)
    const interval = setInterval(() => {
      fetchGenerationJobs(productId)
    }, POLL_MS)

    return () => clearInterval(interval)
  }, [productId, fetchGenerationJobs])

  const activeJobs = useMemo(
    () => generationJobs.filter((job) => isActiveStatus(job.status)),
    [generationJobs]
  )

  const pendingCount = useMemo(
    () => activeJobs.filter((job) => job.status === 'pending').length,
    [activeJobs]
  )

  const runningCount = useMemo(
    () => activeJobs.filter((job) => job.status === 'running').length,
    [activeJobs]
  )

  const totals = useMemo(() => {
    const totalVariations = activeJobs.reduce(
      (sum, job) => sum + (job.variation_count || 0),
      0
    )
    const totalCompleted = activeJobs.reduce(
      (sum, job) => sum + (job.completed_count || 0),
      0
    )
    return { totalVariations, totalCompleted }
  }, [activeJobs])

  const overallProgress =
    totals.totalVariations > 0
      ? Math.round((totals.totalCompleted / totals.totalVariations) * 100)
      : 0

  const hasActiveJobs = activeJobs.length > 0

  return (
    <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/70 backdrop-blur">
      <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/10 text-blue-400">
            {loadingJobs ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <span className="text-xs font-semibold">AI</span>
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-100">Generation queue</p>
            <p className="text-xs text-zinc-500">
              {loadingJobs && generationJobs.length === 0
                ? 'Checking queue...'
                : hasActiveJobs
                  ? `${pendingCount} pending · ${runningCount} running`
                  : 'No active generations'}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          {hasActiveJobs && (
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={async (event) => {
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
              }}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          )}
          <span>
            {totals.totalCompleted}/{totals.totalVariations} images
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>{overallProgress}% overall</span>
          <span>Updates every {POLL_MS / 1000}s</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-500"
            style={{ width: `${overallProgress}%` }}
          />
        </div>

        {expanded && (
          <div className="mt-4 space-y-3">
            {hasActiveJobs ? (
              activeJobs.map((job) => {
                const jobProgress = job.variation_count
                  ? Math.round((job.completed_count / job.variation_count) * 100)
                  : 0

                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-1 text-sm text-zinc-200">
                        {job.final_prompt}
                      </p>
                      <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium capitalize text-zinc-400">
                        {job.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                      <span>
                        {job.completed_count} / {job.variation_count} images
                      </span>
                      <span>{jobProgress}%</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-blue-500/80 transition-all duration-500"
                        style={{ width: `${jobProgress}%` }}
                      />
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-3 py-4 text-xs text-zinc-500">
                Queue is idle. New generations will appear here automatically.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
