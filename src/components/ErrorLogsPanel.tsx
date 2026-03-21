'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, Trash2 } from 'lucide-react'
import { getSafeErrorContext, getSafeErrorMessage } from './errorDisplay.helpers'

export default function ErrorLogsPanel({ projectId }: { projectId: string }) {
  const { errorLogs, loadingErrorLogs, fetchErrorLogs, clearErrorLogs } = useAppStore()
  const [expanded, setExpanded] = useState(false)
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    fetchErrorLogs(projectId)
  }, [projectId, fetchErrorLogs])

  const handleClear = async () => {
    if (!confirm('Clear all error logs for this project?')) return
    setClearing(true)
    try {
      await clearErrorLogs(projectId)
    } finally {
      setClearing(false)
    }
  }

  const toggleEntry = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (errorLogs.length === 0 && !loadingErrorLogs) return null

  return (
    <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
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
              onClick={() => fetchErrorLogs(projectId)}
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
            {errorLogs.map((log) => (
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
                      {getSafeErrorMessage(log.error_message)}
                    </p>
                  </div>
                  {log.error_context && (
                    <ChevronDown
                      className={`h-3 w-3 flex-shrink-0 text-zinc-500 transition-transform ${
                        expandedEntries.has(log.id) ? 'rotate-180' : ''
                      }`}
                    />
                  )}
                </div>
                {expandedEntries.has(log.id) && getSafeErrorContext(log.error_context) && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-900/80 p-2 text-zinc-400">
                    {getSafeErrorContext(log.error_context)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
