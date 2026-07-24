import { describe, expect, it } from 'vitest'
import {
  getGalleryContextMenuPosition,
  getNextMenuFocusIndex,
  getVisibleMenuItems,
  hasMenuDividerBefore,
  isCurrentMenuStatus,
} from './galleryContextMenu.helpers'

describe('galleryContextMenu.helpers', () => {
  it('only exposes permanent delete for rejected images', () => {
    expect(getVisibleMenuItems(null).map((item) => item.action)).not.toContain('delete')
    expect(getVisibleMenuItems('approved').map((item) => item.action)).not.toContain('delete')
    expect(getVisibleMenuItems('rejected').map((item) => item.action)).toContain('delete')
  })

  it('repositions menus that would overflow the viewport and clamps negative coordinates', () => {
    expect(
      getGalleryContextMenuPosition({
        x: 750,
        y: 280,
        itemCount: 6,
        viewportWidth: 800,
        viewportHeight: 300,
      })
    ).toEqual({ x: 550, y: 32 })

    expect(
      getGalleryContextMenuPosition({
        x: -10,
        y: -20,
        itemCount: 2,
        viewportWidth: 800,
        viewportHeight: 500,
      })
    ).toEqual({ x: 8, y: 8 })
  })

  it('estimates taller menu items on touch-sized viewports so bottom menus flip sooner', () => {
    // 6 items * 44px + 4 separators * 9px + 8px padding = 308px on a phone.
    expect(
      getGalleryContextMenuPosition({
        x: 20,
        y: 400,
        itemCount: 6,
        viewportWidth: 390,
        viewportHeight: 700,
      })
    ).toEqual({ x: 20, y: 92 })

    // The same tap point on a desktop viewport keeps the 34px estimate (248px).
    expect(
      getGalleryContextMenuPosition({
        x: 20,
        y: 400,
        itemCount: 6,
        viewportWidth: 1280,
        viewportHeight: 700,
      })
    ).toEqual({ x: 20, y: 400 })
  })

  it('wraps keyboard focus consistently for arrows and tab navigation', () => {
    expect(getNextMenuFocusIndex({ key: 'ArrowDown', currentIndex: 4, itemCount: 5, shiftKey: false })).toBe(0)
    expect(getNextMenuFocusIndex({ key: 'ArrowUp', currentIndex: 0, itemCount: 5, shiftKey: false })).toBe(4)
    expect(getNextMenuFocusIndex({ key: 'Home', currentIndex: 3, itemCount: 5, shiftKey: false })).toBe(0)
    expect(getNextMenuFocusIndex({ key: 'End', currentIndex: 1, itemCount: 5, shiftKey: false })).toBe(4)
    expect(getNextMenuFocusIndex({ key: 'Tab', currentIndex: 0, itemCount: 5, shiftKey: true })).toBe(4)
    expect(getNextMenuFocusIndex({ key: 'Tab', currentIndex: -1, itemCount: 5, shiftKey: false })).toBe(0)
    expect(getNextMenuFocusIndex({ key: 'Enter', currentIndex: 0, itemCount: 5, shiftKey: false })).toBeNull()
  })

  it('draws a leading divider only for the grouped section actions', () => {
    expect(hasMenuDividerBefore('create_video')).toBe(true)
    expect(hasMenuDividerBefore('approve')).toBe(true)
    expect(hasMenuDividerBefore('download')).toBe(true)
    expect(hasMenuDividerBefore('delete')).toBe(true)
    expect(hasMenuDividerBefore('open')).toBe(false)
    expect(hasMenuDividerBefore('reject')).toBe(false)
    expect(hasMenuDividerBefore('request_changes')).toBe(false)
  })

  it('marks only the active approval action as current', () => {
    expect(isCurrentMenuStatus('approve', 'approved')).toBe(true)
    expect(isCurrentMenuStatus('reject', 'rejected')).toBe(true)
    expect(isCurrentMenuStatus('request_changes', 'request_changes')).toBe(true)
    expect(isCurrentMenuStatus('download', 'approved')).toBe(false)
    expect(isCurrentMenuStatus('approve', 'rejected')).toBe(false)
  })
})
