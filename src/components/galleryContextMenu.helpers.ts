import { Check, Download, Eye, MessageSquare, Trash2, Video, X } from 'lucide-react'

export type ContextMenuAction = 'approve' | 'reject' | 'request_changes' | 'download' | 'delete' | 'open' | 'create_video'

export type ContextMenuMediaType = 'image' | 'video' | null

export interface ContextMenuItem {
  action: ContextMenuAction
  label: string
  icon: typeof Check
  shortcut?: string
  className?: string
  condition?: (status: string | null, mediaType: ContextMenuMediaType) => boolean
}

export const MENU_ITEMS: ContextMenuItem[] = [
  { action: 'open', label: 'Open', icon: Eye, shortcut: 'Click' },
  {
    action: 'create_video',
    label: 'Turn into Video',
    icon: Video,
    shortcut: 'V',
    className: 'text-purple-400',
    condition: (_status, mediaType) => mediaType !== 'video',
  },
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
export const MENU_ITEM_HEIGHT_PX = 44
export const MENU_SEPARATOR_HEIGHT_PX = 9
export const MENU_VIEWPORT_MARGIN_PX = 8

// Actions that render a separator immediately above them. Used by the menu to
// draw dividers and by the position estimate to reserve their vertical space.
export const MENU_DIVIDER_ACTIONS: ContextMenuAction[] = ['create_video', 'approve', 'download', 'delete']

export const hasMenuDividerBefore = (action: ContextMenuAction) => MENU_DIVIDER_ACTIONS.includes(action)

export const getVisibleMenuItems = (approvalStatus: string | null, mediaType: ContextMenuMediaType = null) =>
  MENU_ITEMS.filter((item) => !item.condition || item.condition(approvalStatus, mediaType))

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
  const estimatedHeight =
    itemCount * MENU_ITEM_HEIGHT_PX + MENU_DIVIDER_ACTIONS.length * MENU_SEPARATOR_HEIGHT_PX + 8
  const preferredX =
    x + MENU_MIN_WIDTH_PX + MENU_VIEWPORT_MARGIN_PX > viewportWidth ? x - MENU_MIN_WIDTH_PX : x
  const preferredY =
    y + estimatedHeight + MENU_VIEWPORT_MARGIN_PX > viewportHeight ? y - estimatedHeight : y
  const maxX = Math.max(
    MENU_VIEWPORT_MARGIN_PX,
    viewportWidth - MENU_MIN_WIDTH_PX - MENU_VIEWPORT_MARGIN_PX
  )
  const maxY = Math.max(
    MENU_VIEWPORT_MARGIN_PX,
    viewportHeight - estimatedHeight - MENU_VIEWPORT_MARGIN_PX
  )

  return {
    x: Math.min(maxX, Math.max(MENU_VIEWPORT_MARGIN_PX, preferredX)),
    y: Math.min(maxY, Math.max(MENU_VIEWPORT_MARGIN_PX, preferredY)),
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
