'use client'

import { use, useEffect, useState, useMemo } from 'react'
import { useAppStore } from '@/lib/store'
import type { GenerationJob } from '@/lib/types'
import {
  ScrollText,
  Loader2,
  Trash2,
  CheckCircle2,
  XCircle,
  Ban,
  Play,
  Clock,
  Image as ImageIcon,
  Film,
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from 'lucide-react'

const STATUS_CONFIG: Record<
  GenerationJob['status'],
  { label: string; color: string; bg: string; icon: typeof CheckCircle2 }
> = {
  completed: { label: 'Completed', color: 'text-emerald-400', bg: 'bg-emerald-400/10', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-400', bg: 'bg-red-400/10', icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'text-amber-400', bg: 'bg-amber-400/10', icon: Ban },
  running: { label: 'Running', color: 'text-blue-400', bg: 'bg-blue-400/10', icon: Play },
  pending: { label: 'Pending', color: 'text-zinc-400', bg: 'bg-zinc-400/10', icon: Clock },
}

const STATUSES: Array<GenerationJob['status'] | 'all'> = ['all', 'completed', 'failed', 'cancelled', 'running', 'pending']
const JOB_TYPES: Array<GenerationJob['job_type'] | 'all'> = ['all', 'image', 'video']

const PAGE_SIZE = 50

export default function LogPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { id: productId } = use(params)
  const {
    generationJobs,
    loadingJobs,
    fetchGenerationJobs,
    deleteGenerationJob,
    clearGenerationLog,
  } = useAppStore()

  const [statusFilter, setStatusFilter] = useState<GenerationJob['status'] | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<GenerationJob['job_type'] | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    fetchGenerationJobs(productId)
  }, [productId, fetchGenerationJobs])

  const filtered = useMemo(() => {
    let jobs = generationJobs
    if (statusFilter !== 'all') {
      jobs = jobs.filter((j) => j.status === statusFilter)
    }
    if (typeFilter !== 'all') {
      jobs = jobs.filter((j) => j.job_type === typeFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      jobs = jobs.filter(
        (j) =>
          j.final_prompt?.toLowerCase().includes(q) ||
          j.error_message?.toLowerCase().includes(q)
      )
    }
    return jobs
  }, [generationJobs, statusFilter, typeFilter, searchQuery])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  const handleDelete = async (jobId: string) => {
    setDeletingId(jobId)
    try {
      await deleteGenerationJob(productId, jobId)
      if (expandedId === jobId) setExpandedId(null)
    } catch (err) {
      console.error('Failed to delete job', err)
    } finally {
      setDeletingId(null)
    }
  }

  const handleClearLog = async () => {
    setClearing(true)
    try {
      await clearGenerationLog(productId)
      setConfirmClear(false)
    } catch (err) {
      console.error('Failed to clear log', err)
    } finally {
      setClearing(false)
    }
  }

  const isActive = (status: GenerationJob['status']) =>
    status === 'pending' || status === 'running'

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  if (loadingJobs && generationJobs.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <ScrollText className="h-5 w-5 text-zinc-400" />
          <h1 className="text-lg font-semibold text-zinc-100">Generation Log</h1>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
            {filtered.length}
          </span>
        </div>
        {!confirmClear ? (
          <button
            onClick={() => setConfirmClear(true)}
            disabled={generationJobs.filter((j) => !isActive(j.status)).length === 0}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear Log
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">Delete all non-active jobs?</span>
            <button
              onClick={handleClearLog}
              disabled={clearing}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-60"
            >
              {clearing ? 'Clearing...' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="space-y-3">
        {/* Status pills */}
        <div className="flex flex-wrap items-center gap-2">
          {STATUSES.map((s) => {
            const active = statusFilter === s
            const cfg = s === 'all' ? null : STATUS_CONFIG[s]
            return (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setVisibleCount(PAGE_SIZE) }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                {s === 'all' ? 'All' : cfg!.label}
              </button>
            )
          })}

          <span className="mx-1 h-4 w-px bg-zinc-700" />

          {/* Job type toggle */}
          {JOB_TYPES.map((t) => {
            const active = typeFilter === t
            return (
              <button
                key={t}
                onClick={() => { setTypeFilter(t); setVisibleCount(PAGE_SIZE) }}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                {t === 'image' && <ImageIcon className="h-3 w-3" />}
                {t === 'video' && <Film className="h-3 w-3" />}
                {t === 'all' ? 'All Types' : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setVisibleCount(PAGE_SIZE) }}
            placeholder="Search prompts and errors..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-2 pl-9 pr-8 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Job list */}
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 py-16">
          <ScrollText className="mb-3 h-8 w-8 text-zinc-600" />
          <p className="text-sm text-zinc-500">No jobs match the current filters</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((job) => {
            const cfg = STATUS_CONFIG[job.status]
            const StatusIcon = cfg.icon
            const expanded = expandedId === job.id

            return (
              <div
                key={job.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-zinc-700"
              >
                {/* Row header */}
                <button
                  onClick={() => setExpandedId(expanded ? null : job.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
                  )}

                  {/* Status icon */}
                  <StatusIcon className={`h-4 w-4 shrink-0 ${cfg.color}`} />

                  {/* Type badge */}
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    {job.job_type}
                  </span>

                  {/* Prompt preview */}
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                    {job.final_prompt || '(no prompt)'}
                  </span>

                  {/* Timestamp */}
                  <span className="shrink-0 text-xs text-zinc-500">
                    {formatDate(job.created_at)}
                  </span>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(job.id)
                    }}
                    disabled={isActive(job.status) || deletingId === job.id}
                    className="shrink-0 rounded p-1 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-600"
                    title={isActive(job.status) ? 'Cancel the job before deleting' : 'Delete job'}
                  >
                    {deletingId === job.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </button>

                {/* Expanded detail */}
                {expanded && (
                  <div className="border-t border-zinc-800 px-4 py-3 space-y-3">
                    {/* Metadata row */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                      <span>
                        Status:{' '}
                        <span className={cfg.color}>{cfg.label}</span>
                      </span>
                      <span>Model: <span className="text-zinc-300">{job.generation_model}</span></span>
                      <span>Resolution: <span className="text-zinc-300">{job.resolution}</span></span>
                      <span>Aspect: <span className="text-zinc-300">{job.aspect_ratio}</span></span>
                      <span>
                        Variations: <span className="text-zinc-300">{job.completed_count}/{job.variation_count}</span>
                        {job.failed_count > 0 && (
                          <span className="text-red-400"> ({job.failed_count} failed)</span>
                        )}
                      </span>
                      {job.started_at && (
                        <span>Started: <span className="text-zinc-300">{formatDate(job.started_at)}</span></span>
                      )}
                      {job.completed_at && (
                        <span>Finished: <span className="text-zinc-300">{formatDate(job.completed_at)}</span></span>
                      )}
                    </div>

                    {/* Full prompt */}
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Prompt</p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                        {job.final_prompt || '(no prompt)'}
                      </p>
                    </div>

                    {/* Error message */}
                    {job.error_message && (
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-400/70">Error</p>
                        <p className="whitespace-pre-wrap text-sm text-red-400">
                          {job.error_message}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Load more */}
          {hasMore && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="mt-4 w-full rounded-lg border border-zinc-800 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
