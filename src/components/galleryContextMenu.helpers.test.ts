import { describe, expect, it } from 'vitest'
import {
  getGalleryContextMenuPosition,
  getNextMenuFocusIndex,
  getVisibleMenuItems,
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
        x: 350,
        y: 280,
        itemCount: 6,
        viewportWidth: 400,
        viewportHeight: 300,
      })
    ).toEqual({ x: 150, y: 41 })

    expect(
      getGalleryContextMenuPosition({
        x: -10,
        y: -20,
        itemCount: 2,
        viewportWidth: 500,
        viewportHeight: 500,
      })
    ).toEqual({ x: 0, y: 0 })
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

  it('marks only the active approval action as current', () => {
    expect(isCurrentMenuStatus('approve', 'approved')).toBe(true)
    expect(isCurrentMenuStatus('reject', 'rejected')).toBe(true)
    expect(isCurrentMenuStatus('request_changes', 'request_changes')).toBe(true)
    expect(isCurrentMenuStatus('download', 'approved')).toBe(false)
    expect(isCurrentMenuStatus('approve', 'rejected')).toBe(false)
  })
})
