'use client'

import { useCallback, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

export interface ReferenceLightboxImage {
  id: string
  public_url: string | null
  file_name?: string | null
}

interface ReferenceLightboxProps {
  images: ReferenceLightboxImage[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
}

export default function ReferenceLightbox({
  images,
  currentIndex,
  onClose,
  onNavigate,
}: ReferenceLightboxProps) {
  const currentImage = images[currentIndex]
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  const handlePrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1)
  }, [currentIndex, hasPrev, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1)
  }, [currentIndex, hasNext, onNavigate])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          handlePrev()
          break
        case 'ArrowRight':
          handleNext()
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, handlePrev, handleNext])

  if (!currentImage) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex h-full max-h-[90vh] w-full max-w-5xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between rounded-t-xl bg-zinc-900/80 px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-zinc-100">
              {currentImage.file_name ?? `Image ${currentIndex + 1}`}
            </span>
            <span className="text-xs text-zinc-400">
              {currentIndex + 1} / {images.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Close (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-zinc-950">
          {hasPrev && (
            <button
              onClick={handlePrev}
              className="absolute left-4 z-10 rounded-full bg-black/50 p-3 text-white transition-colors hover:bg-black/70"
              title="Previous (←)"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={handleNext}
              className="absolute right-4 z-10 rounded-full bg-black/50 p-3 text-white transition-colors hover:bg-black/70"
              title="Next (→)"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {currentImage.public_url ? (
            <img
              src={currentImage.public_url}
              alt={currentImage.file_name ?? ''}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <div className="text-sm text-zinc-500">No image available</div>
          )}
        </div>
      </div>
    </div>
  )
}
