'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { AlertTriangle, ImageIcon, Loader2, Video, X, CalendarDays } from 'lucide-react'
import { logger } from '@/lib/logger'

type DayBucket = {
  date: string
  images: number
  videos: number
  total: number
}

type SummaryResponse = {
  days: DayBucket[]
  total_images: number
  total_videos: number
  truncated: boolean
}

// Render a 'YYYY-MM-DD' key as a local-timezone label without the UTC-parsing shift that
// `new Date('2026-07-01')` would introduce.
function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  if (!year || !month || !day) return dateKey
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function GenerationActivityModal({
  projectId,
  productFilter,
  mediaFilter,
  onClose,
}: {
  projectId: string
  productFilter: string
  mediaFilter: 'all' | 'image' | 'video'
  onClose: () => void
}) {
  const dialogTitleId = useId()
  const dialogDescriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<SummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useModalShortcuts({ isOpen: true, onClose })

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(false)
      try {
        const params = new URLSearchParams()
        if (productFilter !== 'all') params.set('product_id', productFilter)
        if (mediaFilter !== 'all') params.set('media_type', mediaFilter)
        params.set('tz_offset', String(new Date().getTimezoneOffset()))
        const res = await fetch(`/api/projects/${projectId}/generation-summary?${params}`)
        if (!res.ok) throw new Error('Failed to fetch generation summary')
        const json = (await res.json()) as SummaryResponse
        if (!cancelled) setData(json)
      } catch (err) {
        logger.error('[GenerationActivityModal] Fetch error:', err)
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectId, productFilter, mediaFilter])

  const maxTotal = useMemo(
    () => (data?.days.length ? Math.max(...data.days.map((d) => d.total)) : 0),
    [data]
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
      aria-describedby={dialogDescriptionId}
    >
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div
        ref={dialogRef}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-zinc-800 p-2">
              <CalendarDays className="h-4 w-4 text-zinc-300" />
            </div>
            <div>
              <h2 id={dialogTitleId} className="text-base font-semibold text-zinc-100">Generation activity</h2>
              <p id={dialogDescriptionId} className="mt-0.5 text-xs text-zinc-500">
                Assets generated per day — helps correlate billing with actual output. Counts all
                assets, including rejected and pending.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white sm:min-h-0 sm:min-w-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center" role="status">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-500" />
              <p className="mt-3 text-sm font-medium text-zinc-300">Loading activity</p>
              <p className="mt-1 text-xs text-zinc-500">Counting generated images and videos by day.</p>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-8 text-center" role="alert">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-red-950/60 text-red-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-red-200">Couldn&apos;t load generation activity</p>
              <p className="mt-1 text-xs text-red-300/70">Close this dialog and try again.</p>
            </div>
          ) : !data || data.days.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
                <CalendarDays className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-zinc-300">No generation activity yet</p>
              <p className="mt-1 text-xs text-zinc-500">Generated images and videos will be summarized here.</p>
            </div>
          ) : (
            <>
              {/* Totals */}
              <div className="mb-4 flex flex-wrap gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-zinc-300">
                  <ImageIcon className="h-4 w-4 text-zinc-400" />
                  {data.total_images.toLocaleString()} image{data.total_images !== 1 ? 's' : ''}
                </span>
                <span className="flex items-center gap-1.5 text-zinc-300">
                  <Video className="h-4 w-4 text-purple-400" />
                  {data.total_videos.toLocaleString()} video{data.total_videos !== 1 ? 's' : ''}
                </span>
                <span className="text-zinc-500">
                  across {data.days.length} day{data.days.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Per-day rows */}
              <div className="space-y-2">
                {data.days.map((day) => (
                  <div key={day.date} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-xs text-zinc-400">
                      {formatDayLabel(day.date)}
                    </span>
                    <div
                      className="flex h-5 flex-1 items-center overflow-hidden rounded bg-zinc-800/60"
                      role="img"
                      aria-label={`${day.images} image${day.images !== 1 ? 's' : ''} and ${day.videos} video${day.videos !== 1 ? 's' : ''}`}
                    >
                      {day.images > 0 && (
                        <div
                          className="h-full bg-zinc-500"
                          style={{ width: `${maxTotal ? (day.images / maxTotal) * 100 : 0}%` }}
                          title={`${day.images} image${day.images !== 1 ? 's' : ''}`}
                        />
                      )}
                      {day.videos > 0 && (
                        <div
                          className="h-full bg-purple-500"
                          style={{ width: `${maxTotal ? (day.videos / maxTotal) * 100 : 0}%` }}
                          title={`${day.videos} video${day.videos !== 1 ? 's' : ''}`}
                        />
                      )}
                    </div>
                    <span className="w-8 shrink-0 text-right text-xs font-medium text-zinc-300">
                      {day.total}
                    </span>
                  </div>
                ))}
              </div>

              {data.truncated && (
                <p className="mt-4 text-xs text-amber-400/80">
                  Showing the most recent assets only; older activity is not included.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
