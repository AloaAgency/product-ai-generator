'use client'

import { useEffect, useCallback, useState } from 'react'
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Check,
  XCircle,
  Loader2,
  Copy,
  ExternalLink,
} from 'lucide-react'

export type ApprovalStatus = 'approved' | 'rejected' | 'pending' | null

export interface LightboxImage {
  id: string
  signed_url?: string | null
  download_url?: string | null
  public_url?: string | null
  thumb_signed_url?: string | null
  thumb_public_url?: string | null
  preview_signed_url?: string | null
  preview_public_url?: string | null
  file_name?: string | null
  notes?: string | null
  variation_number?: number | null
  approval_status?: ApprovalStatus
  prompt?: string | null
  productId?: string | null
}

interface ImageLightboxProps {
  images: LightboxImage[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
  onApprovalChange: (imageId: string, status: ApprovalStatus) => Promise<void>
  promptName?: string | null
  projectId?: string | null
  onRequestSignedUrls?: (imageId: string) => Promise<{
    signed_url?: string | null
    download_url?: string | null
    thumb_signed_url?: string | null
    preview_signed_url?: string | null
  } | null>
}

export function ImageLightbox({
  images,
  currentIndex,
  onClose,
  onNavigate,
  onApprovalChange,
  promptName,
  projectId,
  onRequestSignedUrls,
}: ImageLightboxProps) {
  const [isUpdating, setIsUpdating] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const currentImage = images[currentIndex]
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  const handlePrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1)
  }, [currentIndex, hasPrev, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1)
  }, [currentIndex, hasNext, onNavigate])

  const handleApprove = useCallback(async () => {
    if (!currentImage || isUpdating) return
    setIsUpdating(true)
    try {
      const newStatus: ApprovalStatus = currentImage.approval_status === 'approved' ? null : 'approved'
      await onApprovalChange(currentImage.id, newStatus)
    } finally {
      setIsUpdating(false)
    }
  }, [currentImage, isUpdating, onApprovalChange])

  const handleReject = useCallback(async () => {
    if (!currentImage || isUpdating) return
    if (!window.confirm('Delete this image? This action cannot be undone.')) return
    setIsUpdating(true)
    try {
      await onApprovalChange(currentImage.id, 'rejected')
    } finally {
      setIsUpdating(false)
    }
  }, [currentImage, isUpdating, onApprovalChange])

  const handleDownload = useCallback(async () => {
    if (!currentImage) return
    let url = currentImage.download_url || currentImage.signed_url || currentImage.public_url
    if (!url && onRequestSignedUrls) {
      const signed = await onRequestSignedUrls(currentImage.id)
      url = signed?.download_url || signed?.signed_url || url
    }
    if (!url) return

    try {
      const fileName = currentImage.file_name || `product-gen-${currentImage.variation_number || 0}.png`
      const resp = await fetch(url)
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(blobUrl)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }, [currentImage, onRequestSignedUrls])

  const handleCopyPrompt = useCallback(async () => {
    if (!currentImage?.prompt) return
    try {
      await navigator.clipboard.writeText(currentImage.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: ignore clipboard errors
    }
  }, [currentImage?.prompt])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': onClose(); break
        case 'ArrowLeft': handlePrev(); break
        case 'ArrowRight': handleNext(); break
        case 'Enter': e.preventDefault(); void handleApprove(); break
        case 'Delete':
        case 'Backspace': e.preventDefault(); void handleReject(); break
        case 'a': case 'A': void handleApprove(); break
        case 'r': case 'R': void handleReject(); break
        case 'd': case 'D': void handleDownload(); break
        case 'c': case 'C': void handleCopyPrompt(); break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, handlePrev, handleNext, handleApprove, handleReject, handleDownload, handleCopyPrompt])

  // Reset prompt expanded state when navigating to a different image
  useEffect(() => {
    setPromptExpanded(false)
    setCopied(false)
  }, [currentImage?.id])

  // Fetch signed URLs when the current image changes and has no displayable URL
  useEffect(() => {
    if (!currentImage || !onRequestSignedUrls) return
    const hasUrl = currentImage.preview_signed_url || currentImage.preview_public_url
      || currentImage.signed_url || currentImage.public_url
    if (!hasUrl) {
      void onRequestSignedUrls(currentImage.id)
    }
  }, [currentImage?.id, currentImage?.signed_url, currentImage?.preview_signed_url, currentImage?.preview_public_url, currentImage?.public_url, onRequestSignedUrls])

  if (!currentImage) return null

  const imageUrl = currentImage.preview_signed_url
    || currentImage.preview_public_url
    || currentImage.signed_url
    || currentImage.public_url
  const isApproved = currentImage.approval_status === 'approved'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-6xl h-full max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3 bg-gray-900/80 rounded-t-xl">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <span className="text-white font-medium text-sm sm:text-base whitespace-nowrap">
              Variation {currentImage.variation_number ?? currentIndex + 1}
            </span>
            {promptName && (
              <span className="text-gray-400 text-sm truncate max-w-[120px] sm:max-w-[300px] hidden sm:inline">
                {promptName}
              </span>
            )}
            <span className="text-gray-500 text-sm whitespace-nowrap">
              {currentIndex + 1} / {images.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-gray-700"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Prompt section */}
        {currentImage.prompt && (
          <div className="px-4 py-2 bg-gray-900/60 border-b border-gray-800 flex items-start gap-3">
            <button
              onClick={() => setPromptExpanded(!promptExpanded)}
              className={`flex-1 text-left text-sm text-gray-300 ${promptExpanded ? '' : 'line-clamp-2'}`}
            >
              {currentImage.prompt}
            </button>
            <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
              <button
                onClick={handleCopyPrompt}
                className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                title="Copy Prompt (C)"
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
              {projectId && currentImage.productId && (
                <a
                  href={`/projects/${projectId}/products/${currentImage.productId}/generate?prompt=${encodeURIComponent(currentImage.prompt)}`}
                  className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                  title="Generate from Prompt"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Image container */}
        <div className="relative flex-1 flex items-center justify-center bg-gray-950 overflow-hidden">
          {hasPrev && (
            <button
              onClick={handlePrev}
              className="absolute left-2 sm:left-4 z-10 p-2 sm:p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-colors"
            >
              <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={handleNext}
              className="absolute right-2 sm:right-4 z-10 p-2 sm:p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-colors"
            >
              <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          )}

          {imageUrl ? (
            <img
              src={imageUrl}
              alt={currentImage.file_name || `Variation ${currentImage.variation_number}`}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div className="text-gray-500">No image available</div>
          )}

          {isApproved && (
            <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full text-sm font-medium bg-green-500/90 text-white">
              Approved
            </div>
          )}
        </div>

        {/* Footer toolbar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 bg-gray-900/80 rounded-b-xl">
          {/* Thumbnail strip */}
          <div className="flex items-center gap-2 overflow-x-auto max-w-full sm:max-w-[50%] pb-1">
            {images.map((img, index) => {
              const thumbUrl = img.thumb_signed_url || img.thumb_public_url || img.signed_url || img.public_url
              const isActive = index === currentIndex
              const thumbApproved = img.approval_status === 'approved'
              return (
                <button
                  key={img.id}
                  onClick={() => onNavigate(index)}
                  className={`relative flex-shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 transition-all ${
                    isActive
                      ? 'border-white ring-2 ring-white/50'
                      : thumbApproved
                        ? 'border-green-500'
                        : 'border-gray-600 hover:border-gray-400'
                  }`}
                >
                  {thumbUrl && (
                    <img src={thumbUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                  )}
                  {thumbApproved && (
                    <div className="absolute inset-0 flex items-center justify-center bg-green-500/30">
                      <Check className="w-4 h-4 text-green-500" />
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={handleApprove}
              disabled={isUpdating}
              className={`flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg font-medium transition-colors ${
                isApproved
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-700 text-gray-200 hover:bg-green-600 hover:text-white'
              }`}
              title="Approve (Enter or A)"
            >
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span className="hidden sm:inline">Approve</span>
            </button>
            <button
              onClick={handleReject}
              disabled={isUpdating}
              className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg font-medium transition-colors bg-gray-700 text-gray-200 hover:bg-red-600 hover:text-white"
              title="Delete (Delete or R)"
            >
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
              <span className="hidden sm:inline">Delete</span>
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg font-medium bg-gray-700 text-gray-200 hover:bg-blue-600 hover:text-white transition-colors"
              title="Download (D)"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Download</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
