'use client'

import { useEffect, useRef, useMemo, useCallback } from 'react'
import {
  getGalleryContextMenuPosition,
  getNextMenuFocusIndex,
  getVisibleMenuItems,
  hasMenuDividerBefore,
  isCurrentMenuStatus,
  type ContextMenuAction,
  type ContextMenuMediaType,
} from './galleryContextMenu.helpers'

export type { ContextMenuAction, ContextMenuMediaType } from './galleryContextMenu.helpers'

interface GalleryContextMenuProps {
  x: number
  y: number
  imageId: string
  approvalStatus: string | null
  mediaType?: ContextMenuMediaType
  onAction: (action: ContextMenuAction, imageId: string) => void
  onClose: () => void
}

export function GalleryContextMenu({ x, y, imageId, approvalStatus, mediaType = null, onAction, onClose }: GalleryContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    itemRefs.current[0]?.focus()
  }, [])

  // Close on pointer interaction outside or Escape.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleAction = useCallback((action: ContextMenuAction) => {
    onAction(action, imageId)
    onClose()
  }, [onAction, imageId, onClose])

  const visibleItems = getVisibleMenuItems(approvalStatus, mediaType)
  const position = useMemo(() => {
    return getGalleryContextMenuPosition({
      x,
      y,
      itemCount: visibleItems.length,
      viewportWidth: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
      viewportHeight: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight,
    })
  }, [visibleItems.length, x, y])

  const focusItem = useCallback((index: number) => {
    const itemCount = visibleItems.length
    if (itemCount === 0) return
    const normalizedIndex = (index + itemCount) % itemCount
    itemRefs.current[normalizedIndex]?.focus()
  }, [visibleItems.length])

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement)
    const nextIndex = getNextMenuFocusIndex({
      key: event.key,
      currentIndex,
      itemCount: visibleItems.length,
      shiftKey: event.shiftKey,
    })
    if (nextIndex !== null) {
      event.preventDefault()
      focusItem(nextIndex)
    }
  }, [focusItem, visibleItems.length])

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] max-h-[calc(100dvh-1rem)] min-w-[200px] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/50"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label="Image actions"
      onKeyDown={handleMenuKeyDown}
    >
      {visibleItems.map((item, i) => (
        <div key={item.action}>
          {hasMenuDividerBefore(item.action) && <div className="my-1 border-t border-zinc-700" />}
          <button
            ref={(element) => {
              itemRefs.current[i] = element
            }}
            type="button"
            onClick={() => handleAction(item.action)}
            className={`flex min-h-11 w-full items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-zinc-700 ${
              item.className ?? 'text-zinc-200'
            }`}
            role="menuitem"
          >
            <item.icon className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 text-left">{item.label}</span>
            {isCurrentMenuStatus(item.action, approvalStatus) && (
              <span className="text-xs text-zinc-500">current</span>
            )}
            {item.shortcut && !isCurrentMenuStatus(item.action, approvalStatus) && (
              <span className="text-xs text-zinc-500">{item.shortcut}</span>
            )}
          </button>
        </div>
      ))}
    </div>
  )
}
