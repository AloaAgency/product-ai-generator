'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'

export const TOAST_AUTO_DISMISS_MS = 6000

export type TransientToastTone = 'error' | 'success' | 'info'

const TOAST_BORDER_BY_TONE: Record<TransientToastTone, string> = {
  error: 'border-red-700/60',
  success: 'border-emerald-700/50',
  info: 'border-purple-700/50',
}

export function TransientToast({
  tone,
  message,
  icon,
  onDismiss,
}: {
  tone: TransientToastTone
  message: string
  icon?: ReactNode
  onDismiss: () => void
}) {
  const onDismissRef = useRef(onDismiss)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), TOAST_AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [message, tone])

  const leadingIcon =
    tone === 'error' ? (
      <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
    ) : (
      icon ?? (tone === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : null)
    )

  return (
    <div
      className="fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[120] flex justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div
        className={`flex min-w-0 max-w-lg flex-1 items-center gap-3 rounded-lg border bg-zinc-900 px-3 py-2 text-sm text-zinc-100 shadow-xl shadow-black/50 sm:px-4 sm:py-3 ${TOAST_BORDER_BY_TONE[tone]}`}
      >
        {leadingIcon}
        <span className="min-w-0 flex-1 break-words">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
