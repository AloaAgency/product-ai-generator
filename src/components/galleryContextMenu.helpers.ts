import { Check, Download, Eye, MessageSquare, Trash2, X } from 'lucide-react'

export type ContextMenuAction = 'approve' | 'reject' | 'request_changes' | 'download' | 'delete' | 'open'

export interface ContextMenuItem {
  action: ContextMenuAction
  label: string
  icon: typeof Check
  shortcut?: string
  className?: string
  condition?: (status: string | null) => boolean
}

export const MENU_ITEMS: ContextMenuItem[] = [
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

export const MENU_MIN_WIDTH_PX = 200
export const MENU_ITEM_HEIGHT_PX = 34
export const MENU_SEPARATOR_HEIGHT_PX = 9

export const getVisibleMenuItems = (approvalStatus: string | null) =>
  MENU_ITEMS.filter((item) => !item.condition || item.condition(approvalStatus))

export const getGalleryContextMenuPosition = ({
  x,
  y,
  itemCount,
  viewportWidth,
  viewportHeight,
}: {
  x: number
  y: number
  itemCount: number
  viewportWidth: number
  viewportHeight: number
}) => {
  const estimatedHeight = itemCount * MENU_ITEM_HEIGHT_PX + 3 * MENU_SEPARATOR_HEIGHT_PX + 8
  const adjustedX = x + MENU_MIN_WIDTH_PX > viewportWidth ? x - MENU_MIN_WIDTH_PX : x
  const adjustedY = y + estimatedHeight > viewportHeight ? y - estimatedHeight : y

  return {
    x: Math.max(0, adjustedX),
    y: Math.max(0, adjustedY),
  }
}

export const isCurrentMenuStatus = (action: ContextMenuAction, approvalStatus: string | null) => {
  if (action === 'approve' && approvalStatus === 'approved') return true
  if (action === 'reject' && approvalStatus === 'rejected') return true
  if (action === 'request_changes' && approvalStatus === 'request_changes') return true
  return false
}

export const getNextMenuFocusIndex = ({
  key,
  currentIndex,
  itemCount,
  shiftKey,
}: {
  key: string
  currentIndex: number
  itemCount: number
  shiftKey: boolean
}) => {
  if (itemCount === 0) return null

  switch (key) {
    case 'ArrowDown':
      return currentIndex >= 0 ? (currentIndex + 1) % itemCount : 0
    case 'ArrowUp':
      return currentIndex >= 0 ? (currentIndex - 1 + itemCount) % itemCount : itemCount - 1
    case 'Home':
      return 0
    case 'End':
      return itemCount - 1
    case 'Tab':
      if (currentIndex < 0) return 0
      return shiftKey
        ? (currentIndex - 1 + itemCount) % itemCount
        : (currentIndex + 1) % itemCount
    default:
      return null
  }
}
