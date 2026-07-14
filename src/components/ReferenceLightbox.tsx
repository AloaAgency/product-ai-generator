'use client'

import { useCallback, useEffect, useId, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, ImageOff } from 'lucide-react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { FallbackImage } from './FallbackImage'
import { getDownloadImageUrl } from './imageLightbox.helpers'

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
  const dialogTitleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const currentImage = images[currentIndex]
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const handlePrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1)
  }, [currentIndex, hasPrev, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1)
  }, [currentIndex, hasNext, onNavigate])

  useModalShortcuts({
    isOpen: true,
    onClose,
  })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          handlePrev()
          break
        case 'ArrowRight':
          e.preventDefault()
          handleNext()
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext])

  if (!currentImage) return null
  const imageUrl = getDownloadImageUrl({
    id: currentImage.id,
    public_url: currentImage.public_url,
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <div className="fixed inset-0 bg-black/90" onClick={onClose} />
      <div
        ref={dialogRef}
        className="relative z-10 flex h-full max-h-[90vh] w-full max-w-5xl flex-col"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between rounded-t-xl bg-zinc-900/80 px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4" aria-live="polite" aria-atomic="true">
            <span id={dialogTitleId} className="truncate text-sm font-medium text-zinc-100">
              {currentImage.file_name ?? `Image ${currentIndex + 1}`}
            </span>
            <span className="shrink-0 text-sm text-zinc-500">
              {currentIndex + 1} / {images.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white sm:min-h-0 sm:min-w-0"
            title="Close (Esc)"
            aria-label="Close lightbox"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-950">
          {hasPrev && (
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-2 z-10 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 sm:left-4 sm:p-3"
              title="Previous (←)"
              aria-label="Previous reference image"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-2 z-10 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 sm:right-4 sm:p-3"
              title="Next (→)"
              aria-label="Next reference image"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          <FallbackImage
            sources={[imageUrl]}
            alt={currentImage.file_name ?? `Reference image ${currentIndex + 1}`}
            className="max-h-full max-w-full object-contain"
            fallback={(
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
                <div className="rounded-full bg-zinc-900 p-3">
                  <ImageOff className="h-6 w-6 text-zinc-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-300">No image available</p>
                  <p className="mt-1 text-xs text-zinc-500">This reference image does not have a renderable preview.</p>
                </div>
              </div>
            )}
          />
        </div>
      </div>
    </div>
  )
}
