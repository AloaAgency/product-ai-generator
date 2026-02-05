import { useEffect } from 'react'

/**
 * Keyboard shortcuts for modals:
 * - Escape → close
 * - Cmd/Ctrl+Enter → submit (optional)
 */
export function useModalShortcuts({
  isOpen,
  onClose,
  onSubmit,
}: {
  isOpen: boolean
  onClose: () => void
  onSubmit?: (() => void) | null
}) {
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose, onSubmit])
}
