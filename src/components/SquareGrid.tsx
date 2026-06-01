'use client'

import type { ReactNode } from 'react'

export function SquareGrid<T>({
  items,
  getItemKey,
  renderItem,
}: {
  items: T[]
  getItemKey: (item: T, index: number) => string
  renderItem: (item: T, index: number) => ReactNode
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((item, index) => (
        <div key={getItemKey(item, index)} className="aspect-square min-w-0">
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  )
}
