'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Check, X, MessageSquare, Download, Trash2, Eye } from 'lucide-react'

export type ContextMenuAction = 'approve' | 'reject' | 'request_changes' | 'download' | 'delete' | 'open'

interface GalleryContextMenuProps {
  x: number
  y: number
  imageId: string
  approvalStatus: string | null
  onAction: (action: ContextMenuAction, imageId: string) => void
  onClose: () => void
}

const MENU_ITEMS: {
  action: ContextMenuAction
  label: string
  icon: typeof Check
  shortcut?: string
  className?: string
  condition?: (status: string | null) => boolean
}[] = [
  { action: 'open', label: 'Open', icon: Eye, shortcut: 'Click' },
  { action: 'approve', label: 'Approve', icon: Check, shortcut: 'A', className: 'text-green-400' },
  { action: 'reject', label: 'Reject', icon: X, shortcut: 'R', className: 'text-red-400' },
  { action: 'request_changes', label: 'Request Changes', icon: MessageSquare, shortcut: 'C', className: 'text-orange-400' },
  { action: 'download', label: 'Download', icon: Download, shortcut: 'D' },
  {
    action: 'delete',
    label: 'Delete',
    icon: Trash2,
    shortcut: 'Del',
    className: 'text-red-400',
    condition: (status) => status === 'rejected',
  },
]

export function GalleryContextMenu({ x, y, imageId, approvalStatus, onAction, onClose }: GalleryContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  // Adjust position to keep menu within viewport
  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const adjustedX = x + rect.width > window.innerWidth ? x - rect.width : x
    const adjustedY = y + rect.height > window.innerHeight ? y - rect.height : y
    setPosition({ x: Math.max(0, adjustedX), y: Math.max(0, adjustedY) })
  }, [x, y])

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleAction = useCallback((action: ContextMenuAction) => {
    onAction(action, imageId)
    onClose()
  }, [onAction, imageId, onClose])

  const visibleItems = MENU_ITEMS.filter((item) => !item.condition || item.condition(approvalStatus))

  // Show a check mark next to the current status
  const isCurrentStatus = (action: ContextMenuAction) => {
    if (action === 'approve' && approvalStatus === 'approved') return true
    if (action === 'reject' && approvalStatus === 'rejected') return true
    if (action === 'request_changes' && approvalStatus === 'request_changes') return true
    return false
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[200px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/50"
      style={{ left: position.x, top: position.y }}
    >
      {visibleItems.map((item, i) => (
        <div key={item.action}>
          {i === 1 && <div className="my-1 border-t border-zinc-700" />}
          {item.action === 'download' && <div className="my-1 border-t border-zinc-700" />}
          {item.action === 'delete' && <div className="my-1 border-t border-zinc-700" />}
          <button
            onClick={() => handleAction(item.action)}
            className={`flex w-full items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-700 ${
              item.className ?? 'text-zinc-200'
            }`}
          >
            <item.icon className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 text-left">{item.label}</span>
            {isCurrentStatus(item.action) && (
              <span className="text-xs text-zinc-500">current</span>
            )}
            {item.shortcut && !isCurrentStatus(item.action) && (
              <span className="text-xs text-zinc-500">{item.shortcut}</span>
            )}
          </button>
        </div>
      ))}
    </div>
  )
}
