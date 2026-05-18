'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

const GRID_GAP_PX = 16

type GridMetrics = {
  top: number
  width: number
  viewportHeight: number
}

function getColumnCount(width: number) {
  if (width >= 1280) return 6
  if (width >= 1024) return 5
  if (width >= 768) return 4
  if (width >= 640) return 3
  return 2
}

function buildInitialMetrics(): GridMetrics {
  if (typeof window === 'undefined') {
    return { top: 0, width: 0, viewportHeight: 0 }
  }

  return {
    top: 0,
    width: window.innerWidth,
    viewportHeight: window.innerHeight,
  }
}

export function VirtualizedSquareGrid<T>({
  items,
  getItemKey,
  renderItem,
  overscanRows = 2,
}: {
  items: T[]
  getItemKey: (item: T, index: number) => string
  renderItem: (item: T, index: number) => ReactNode
  overscanRows?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const [metrics, setMetrics] = useState<GridMetrics>(buildInitialMetrics)

  const measure = useCallback(() => {
    const node = containerRef.current
    if (!node) return

    const rect = node.getBoundingClientRect()
    const nextMetrics = {
      top: rect.top,
      width: rect.width,
      viewportHeight: window.innerHeight,
    }

    setMetrics((prev) => (
      prev.top === nextMetrics.top &&
      prev.width === nextMetrics.width &&
      prev.viewportHeight === nextMetrics.viewportHeight
    ) ? prev : nextMetrics)
  }, [])

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node) return

    measure()

    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure()
    })
    resizeObserver.observe(node)

    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, { passive: true })

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [measure, scheduleMeasure])

  const columns = useMemo(() => getColumnCount(metrics.width), [metrics.width])
  const itemSize = useMemo(() => {
    if (columns <= 0 || metrics.width <= 0) return 0
    return Math.max(0, (metrics.width - GRID_GAP_PX * (columns - 1)) / columns)
  }, [columns, metrics.width])
  const rowHeight = itemSize + GRID_GAP_PX
  const totalRows = columns > 0 ? Math.ceil(items.length / columns) : 0
  const totalHeight = totalRows > 0 ? totalRows * itemSize + (totalRows - 1) * GRID_GAP_PX : 0

  const visibleRange = useMemo(() => {
    if (items.length === 0 || itemSize === 0 || rowHeight === 0 || totalRows === 0) {
      return { startRow: 0, endRow: -1 }
    }

    const viewportStart = Math.max(0, -metrics.top)
    const viewportEnd = Math.min(totalHeight, metrics.viewportHeight - metrics.top)

    if (viewportEnd <= 0 || viewportStart >= totalHeight) {
      return { startRow: 0, endRow: -1 }
    }

    const overscanPx = overscanRows * rowHeight
    const startRow = Math.max(0, Math.floor((viewportStart - overscanPx) / rowHeight))
    const endRow = Math.min(totalRows - 1, Math.floor((viewportEnd + overscanPx) / rowHeight))
    return { startRow, endRow }
  }, [itemSize, items.length, metrics.top, metrics.viewportHeight, overscanRows, rowHeight, totalHeight, totalRows])

  const visibleItems = useMemo(() => {
    if (visibleRange.endRow < visibleRange.startRow || columns <= 0) return []

    const startIndex = visibleRange.startRow * columns
    const endIndex = Math.min(items.length, (visibleRange.endRow + 1) * columns)

    return items.slice(startIndex, endIndex).map((item, offset) => {
      const index = startIndex + offset
      const row = Math.floor(index / columns)
      const column = index % columns
      return {
        item,
        index,
        row,
        column,
      }
    })
  }, [columns, items, visibleRange.endRow, visibleRange.startRow])

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight || undefined }}>
      {visibleItems.map(({ item, index, row, column }) => (
        <div
          key={getItemKey(item, index)}
          className="absolute"
          style={{
            width: itemSize,
            height: itemSize,
            transform: `translate(${column * (itemSize + GRID_GAP_PX)}px, ${row * (itemSize + GRID_GAP_PX)}px)`,
          }}
        >
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  )
}
