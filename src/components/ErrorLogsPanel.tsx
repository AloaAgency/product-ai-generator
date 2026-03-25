'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, Trash2 } from 'lucide-react'
import { getSafeErrorContext, getSafeErrorMessage } from './errorDisplay.helpers'

const PAGE_SIZE = 20

export default function ErrorLogsPanel({ projectId }: { projectId: string }) {
  const errorLogs = useAppStore((state) => state.errorLogs)
  const loadingErrorLogs = useAppStore((state) => state.loadingErrorLogs)
  const fetchErrorLogs = useAppStore((state) => state.fetchErrorLogs)
  const clearErrorLogs = useAppStore((state) => state.clearErrorLogs)
  const [expanded, setExpanded] = useState(false)
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    void fetchErrorLogs(projectId)
  }, [projectId, fetchErrorLogs])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setExpandedEntries(new Set())
  }, [projectId, errorLogs.length])

  const visibleLogs = useMemo(() => {
    return errorLogs.slice(0, visibleCount).map((log) => ({
      ...log,
      safeMessage: getSafeErrorMessage(log.error_message),
      safeContext: getSafeErrorContext(log.error_context),
    }))
  }, [errorLogs, visibleCount])

  const hasMoreLogs = visibleCount < errorLogs.length

  const handleClear = useCallback(async () => {
    if (!confirm('Clear all error logs for this project?')) return
    setClearing(true)
    try {
      await clearErrorLogs(projectId)
    } finally {
      setClearing(false)
    }
  }, [clearErrorLogs, projectId])

  const toggleEntry = useCallback((id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  const handleRefresh = useCallback(() => {
    setVisibleCount(PAGE_SIZE)
    setExpandedEntries(new Set())
    void fetchErrorLogs(projectId)
  }, [fetchErrorLogs, projectId])

  if (errorLogs.length === 0 && !loadingErrorLogs) return null

  return (
    <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20">
      <button
        type="button"
        onClick={handleToggleExpanded}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-red-400 hover:bg-red-950/30 transition-colors rounded-lg"
        aria-expanded={expanded}
      >
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span className="flex-1">
          Error Logs
          {errorLogs.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-900/60 px-2 py-0.5 text-xs font-semibold text-red-300">
              {errorLogs.length}
            </span>
          )}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {expanded && (
        <div className="border-t border-red-900/40 px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loadingErrorLogs}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-3 w-3 ${loadingErrorLogs ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={clearing || errorLogs.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-900/40 px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/60 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Clear All
            </button>
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {visibleLogs.map((log) => (
              <div
                key={log.id}
                className="rounded-md border border-red-900/30 bg-red-950/30 p-2.5 text-xs"
              >
                <div
                  className="flex items-start gap-2 cursor-pointer"
                  onClick={() => toggleEntry(log.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-zinc-500">
                      <span>{new Date(log.created_at).toLocaleString()}</span>
                      {log.error_source && (
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                          {log.error_source}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-red-300 break-words">
                      {log.safeMessage}
                    </p>
                  </div>
                  {log.safeContext && (
                    <ChevronDown
                      className={`h-3 w-3 flex-shrink-0 text-zinc-500 transition-transform ${
                        expandedEntries.has(log.id) ? 'rotate-180' : ''
                      }`}
                    />
                  )}
                </div>
                {expandedEntries.has(log.id) && log.safeContext && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-900/80 p-2 text-zinc-400">
                    {log.safeContext}
                  </pre>
                )}
              </div>
            ))}
            {hasMoreLogs && (
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                className="w-full rounded-md border border-red-900/30 bg-red-950/20 px-3 py-2 text-xs font-medium text-red-200 transition-colors hover:bg-red-950/30"
              >
                Load more ({errorLogs.length - visibleCount} remaining)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
