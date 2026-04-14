'use client'

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import {
  AlertCircle,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Check,
  XCircle,
  Loader2,
  Copy,
  ExternalLink,
  Trash2,
  AlertTriangle,
  ImageOff,
  Wand2,
  RefreshCw,
} from 'lucide-react'
import {
  getFixImageHref,
  getFullImageUrl,
  getDisplayImageUrl,
  getDownloadImageUrl,
  getKeyboardAction,
  getLightboxDisplayName,
  getLightboxThumbnailUrl,
  getLightboxWarmupIndexes,
  getNextApprovalStatus,
  getPreviewImageUrl,
  sanitizeRouteSegment,
  shouldRequestSignedUrls,
} from './imageLightbox.helpers'
import { getSafeDownloadErrorMessage, getSafeErrorMessage } from './errorDisplay.helpers'

export type ApprovalStatus = 'approved' | 'rejected' | 'pending' | 'request_changes' | null

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
  // Job settings for regeneration
  reference_set_id?: string | null
  texture_set_id?: string | null
  product_image_count?: number | null
  texture_image_count?: number | null
}

interface ImageLightboxProps {
  images: LightboxImage[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
  onApprovalChange: (imageId: string, status: ApprovalStatus, notes?: string) => Promise<void>
  onDelete?: (imageId: string) => Promise<void>
  promptName?: string | null
  projectId?: string | null
  onRequestSignedUrls?: (imageId: string) => Promise<{
    signed_url?: string | null
    download_url?: string | null
    thumb_signed_url?: string | null
    preview_signed_url?: string | null
  } | null>
}

/** Build generate URL with all job settings pre-filled for regeneration */
function buildRegenerateUrl(projectId: string, image: LightboxImage): string {
  const safeProjectId = sanitizeRouteSegment(projectId)
  const safeProductId = sanitizeRouteSegment(image.productId)
  if (!safeProjectId || !safeProductId) return '#'

  const params = new URLSearchParams()
  if (image.prompt) params.set('prompt', image.prompt)
  if (image.reference_set_id) params.set('reference_set_id', image.reference_set_id)
  if (image.texture_set_id) params.set('texture_set_id', image.texture_set_id)
  if (image.product_image_count != null) params.set('product_image_count', String(image.product_image_count))
  if (image.texture_image_count != null) params.set('texture_image_count', String(image.texture_image_count))
  return `/projects/${safeProjectId}/products/${safeProductId}/generate?${params.toString()}`
}

const LightboxThumbnailButton = memo(function LightboxThumbnailButton({
  id,
  thumbUrl,
  index,
  isActive,
  approvalStatus,
  onNavigate,
}: {
  id: string
  thumbUrl: string | null
  index: number
  isActive: boolean
  approvalStatus: ApprovalStatus | undefined
  onNavigate: (index: number) => void
}) {
  const isApproved = approvalStatus === 'approved'
  const isRejected = approvalStatus === 'rejected'
  const isRequestChanges = approvalStatus === 'request_changes'

  return (
    <button
      type="button"
      onClick={() => onNavigate(index)}
      className={`relative flex-shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 transition-all ${
        isActive
          ? 'border-white ring-2 ring-white/50'
          : isApproved
            ? 'border-green-500'
            : isRejected
              ? 'border-red-500'
              : isRequestChanges
                ? 'border-orange-500'
                : 'border-gray-600 hover:border-gray-400'
      }`}
      aria-label={`View image ${index + 1}`}
      data-image-id={id}
    >
      {thumbUrl && (
        <img src={thumbUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
      )}
      {isApproved && (
        <div className="absolute inset-0 flex items-center justify-center bg-green-500/30">
          <Check className="w-4 h-4 text-green-500" />
        </div>
      )}
      {isRejected && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500/30">
          <XCircle className="w-4 h-4 text-red-500" />
        </div>
      )}
      {isRequestChanges && (
        <div className="absolute inset-0 flex items-center justify-center bg-orange-500/30">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
        </div>
      )}
    </button>
  )
})

export function ImageLightbox({
  images,
  currentIndex,
  onClose,
  onNavigate,
  onApprovalChange,
  onDelete,
  promptName,
  projectId,
  onRequestSignedUrls,
}: ImageLightboxProps) {
  const dialogTitleId = useId()
  const [isUpdating, setIsUpdating] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [notesValue, setNotesValue] = useState('')
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null)
  const notesInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const preloadCacheRef = useRef<Map<string, Promise<void>>>(new Map())

  const currentImage = images[currentIndex]
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  // Sync notes when navigating
  useEffect(() => {
    setNotesValue(currentImage?.notes || '')
    setPromptExpanded(false)
    setCopied(false)
    setActionNotice(null)
  }, [currentImage?.id, currentImage?.notes])

  useEffect(() => {
    if (!actionNotice) return
    const timeout = window.setTimeout(() => setActionNotice(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [actionNotice])

  const preloadImage = useCallback((url: string | null) => {
    if (!url) return Promise.resolve()

    const cached = preloadCacheRef.current.get(url)
    if (cached) return cached

    const img = new window.Image()
    img.decoding = 'async'
    img.src = url

    const pending = (typeof img.decode === 'function'
      ? img.decode().catch(() => undefined)
      : new Promise<void>((resolve) => {
          img.onload = () => resolve()
          img.onerror = () => resolve()
        }))
      .finally(() => {
        preloadCacheRef.current.set(url, Promise.resolve())
      })

    preloadCacheRef.current.set(url, pending)
    return pending
  }, [])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const handlePrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1)
  }, [currentIndex, hasPrev, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1)
  }, [currentIndex, hasNext, onNavigate])

  const handleFirst = useCallback(() => {
    if (currentIndex > 0) onNavigate(0)
  }, [currentIndex, onNavigate])

  const handleLast = useCallback(() => {
    if (currentIndex < images.length - 1) onNavigate(images.length - 1)
  }, [currentIndex, images.length, onNavigate])

  const setErrorNotice = useCallback((error: unknown, fallback: string) => {
    setActionNotice({
      type: 'error',
      message: getSafeErrorMessage(error instanceof Error ? error.message : null, fallback),
    })
  }, [])

  const runUpdatingAction = useCallback(async (action: () => Promise<void>) => {
    if (!currentImage || isUpdating) return
    setIsUpdating(true)
    try {
      await action()
      setActionNotice(null)
    } catch (error) {
      setErrorNotice(error, 'Failed to update approval. Please try again.')
    } finally {
      setIsUpdating(false)
    }
  }, [currentImage, isUpdating, setErrorNotice])

  const handleApprovalAction = useCallback(async (targetStatus: Exclude<ApprovalStatus, 'pending' | null>) => {
    if (!currentImage) return

    await runUpdatingAction(async () => {
      const newStatus = getNextApprovalStatus(currentImage.approval_status, targetStatus)
      await onApprovalChange(currentImage.id, newStatus)
    })
  }, [currentImage, onApprovalChange, runUpdatingAction])

  const handleApprove = useCallback(async () => {
    await handleApprovalAction('approved')
  }, [handleApprovalAction])

  const handleReject = useCallback(async () => {
    await handleApprovalAction('rejected')
  }, [handleApprovalAction])

  const handleRequestChanges = useCallback(async () => {
    await handleApprovalAction('request_changes')
  }, [handleApprovalAction])

  const handlePermanentDelete = useCallback(async () => {
    if (!currentImage || isUpdating || !onDelete) return
    if (!window.confirm('Permanently delete this image? This cannot be undone.')) return
    await runUpdatingAction(async () => {
      await onDelete(currentImage.id)
    })
  }, [currentImage, isUpdating, onDelete, runUpdatingAction])

  const handleSaveNotes = useCallback(async () => {
    if (!currentImage) return
    const status = currentImage.approval_status
    if (status !== 'rejected' && status !== 'request_changes') return
    const trimmedNotes = notesValue.trim()
    if (trimmedNotes === (currentImage.notes || '').trim()) return
    try {
      await onApprovalChange(currentImage.id, status, trimmedNotes)
      setActionNotice(trimmedNotes ? { type: 'success', message: 'Notes saved.' } : null)
    } catch (error) {
      setErrorNotice(error, 'Failed to save notes. Please try again.')
    }
  }, [currentImage, notesValue, onApprovalChange, setErrorNotice])

  const handleDownload = useCallback(async () => {
    if (!currentImage) return
    let url = getDownloadImageUrl(currentImage)
    if (!url && onRequestSignedUrls) {
      const signed = await onRequestSignedUrls(currentImage.id)
      url = getDownloadImageUrl(currentImage, signed)
    }
    if (!url) {
      setActionNotice({ type: 'error', message: 'Download is unavailable for this image right now.' })
      return
    }

    try {
      const fileName = currentImage.file_name || `product-gen-${currentImage.variation_number || 0}.png`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(blobUrl)
      setActionNotice(null)
    } catch (error) {
      setActionNotice({
        type: 'error',
        message: getSafeDownloadErrorMessage(error instanceof Error ? error.message : null),
      })
    }
  }, [currentImage, onRequestSignedUrls])

  const handleCopyPrompt = useCallback(async () => {
    if (!currentImage?.prompt) return
    try {
      await navigator.clipboard.writeText(currentImage.prompt)
      setCopied(true)
      setActionNotice({ type: 'success', message: 'Prompt copied.' })
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      setErrorNotice(error, 'Copy failed. Please copy the prompt manually.')
    }
  }, [currentImage?.prompt, setErrorNotice])

  const isRejected = currentImage?.approval_status === 'rejected'
  const isApproved = currentImage?.approval_status === 'approved'
  const isRequestChanges = currentImage?.approval_status === 'request_changes'
  const showNotesInput = isRejected || isRequestChanges

  useModalShortcuts({
    isOpen: true,
    onClose,
  })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { action, preventDefault } = getKeyboardAction({
        key: e.key,
        isNotesFocused: !!notesInputRef.current && document.activeElement === notesInputRef.current,
        isRejected,
        hasDelete: !!onDelete,
      })
      if (preventDefault) e.preventDefault()

      switch (action) {
        case 'blurNotes':
          notesInputRef.current?.blur()
          break
        case 'close':
          break
        case 'prev':
          handlePrev()
          break
        case 'next':
          handleNext()
          break
        case 'first':
          handleFirst()
          break
        case 'last':
          handleLast()
          break
        case 'approve':
          void handleApprove()
          break
        case 'delete':
          void handlePermanentDelete()
          break
        case 'reject':
          void handleReject()
          break
        case 'download':
          void handleDownload()
          break
        case 'requestChanges':
          void handleRequestChanges()
          break
        case 'none':
          if (e.key === 'p' || e.key === 'P') {
            void handleCopyPrompt()
          }
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext, handleFirst, handleLast, handleApprove, handleReject, handleDownload, handleCopyPrompt, handleRequestChanges, handlePermanentDelete, isRejected, onDelete])

  // Fetch signed URLs when the current image changes and has no displayable URL
  useEffect(() => {
    if (!currentImage || !onRequestSignedUrls) return
    if (shouldRequestSignedUrls(currentImage, !!onRequestSignedUrls)) {
      void onRequestSignedUrls(currentImage.id)
    }
  }, [currentImage, onRequestSignedUrls])

  // Start with a fast preview/thumbnail, then upgrade to full resolution only after it has decoded.
  useEffect(() => {
    if (!currentImage) {
      setResolvedImageUrl(null)
      return
    }

    const previewUrl = getPreviewImageUrl(currentImage)
    const fullUrl = getFullImageUrl(currentImage)
    const immediateUrl = previewUrl || fullUrl
    let cancelled = false

    setResolvedImageUrl(immediateUrl)

    if (fullUrl && fullUrl !== immediateUrl) {
      void preloadImage(fullUrl).then(() => {
        if (!cancelled) setResolvedImageUrl(fullUrl)
      })
    }

    return () => {
      cancelled = true
    }
  }, [
    currentImage,
    currentImage?.id,
    currentImage?.preview_signed_url,
    currentImage?.preview_public_url,
    currentImage?.thumb_signed_url,
    currentImage?.thumb_public_url,
    currentImage?.signed_url,
    currentImage?.public_url,
    preloadImage,
  ])

  useEffect(() => {
    for (const index of getLightboxWarmupIndexes(currentIndex)) {
      const image = images[index]
      if (!image) continue
      void preloadImage(getDisplayImageUrl(image))
      void preloadImage(getFullImageUrl(image))
    }
  }, [currentIndex, images, preloadImage])

  const thumbnailItems = useMemo(
    () =>
      images.map((img, index) => ({
        id: img.id,
        index,
        thumbUrl: getLightboxThumbnailUrl(img),
        approvalStatus: img.approval_status,
        isActive: index === currentIndex,
      })),
    [images, currentIndex]
  )

  if (!currentImage) return null

  const imageUrl = resolvedImageUrl ?? getDisplayImageUrl(currentImage)
  const displayName = getLightboxDisplayName({
    fileName: currentImage.file_name,
    variationNumber: currentImage.variation_number,
    currentIndex,
  })
  const fixImageHref = getFixImageHref({
    projectId,
    productId: currentImage.productId,
    imageId: currentImage.id,
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
        className="relative z-10 flex h-full max-h-[90vh] w-full max-w-6xl flex-col"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between rounded-t-xl bg-zinc-900/80 px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <span id={dialogTitleId} className="whitespace-nowrap text-sm font-medium text-zinc-100 sm:text-base">
              {displayName}
            </span>
            {promptName && (
              <span className="hidden max-w-[120px] truncate text-sm text-zinc-400 sm:inline sm:max-w-[300px]">
                {promptName}
              </span>
            )}
            <span className="whitespace-nowrap text-sm text-zinc-500">
              {currentIndex + 1} / {images.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Close (Esc)"
            aria-label="Close lightbox"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Prompt section – collapsed by default, capped height when expanded */}
        {currentImage.prompt && (
          <div className="flex items-start gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
            <button
              type="button"
              onClick={() => setPromptExpanded(!promptExpanded)}
              className={`flex-1 cursor-pointer text-left text-sm text-zinc-300 ${promptExpanded ? 'max-h-20 overflow-y-auto' : 'overflow-hidden whitespace-nowrap text-ellipsis'}`}
              aria-expanded={promptExpanded}
              aria-label={promptExpanded ? 'Collapse prompt' : 'Expand prompt'}
            >
              {currentImage.prompt}
            </button>
            <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                title="Copy Prompt (P)"
                aria-label="Copy prompt"
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
              {projectId && currentImage.productId && (
                <a
                  href={buildRegenerateUrl(projectId, currentImage)}
                  className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                  title="Regenerate with this prompt"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Image container */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-950">
          {hasPrev && (
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-2 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 sm:left-4 sm:p-3"
              aria-label="Previous image"
            >
              <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-2 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 sm:right-4 sm:p-3"
              aria-label="Next image"
            >
              <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          )}

          {imageUrl ? (
            <img
              src={imageUrl}
              alt={displayName}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
              <div className="rounded-full bg-zinc-900 p-3">
                <ImageOff className="h-6 w-6 text-zinc-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-300">No image available</p>
                <p className="mt-1 text-xs text-zinc-500">This variation does not have a renderable preview yet.</p>
              </div>
            </div>
          )}

          {isApproved && (
            <div className="absolute right-4 top-4 rounded-full bg-emerald-950/90 px-3 py-1.5 text-sm font-medium text-emerald-200">
              Approved
            </div>
          )}
          {isRejected && (
            <div className="absolute right-4 top-4 rounded-full bg-red-950/90 px-3 py-1.5 text-sm font-medium text-red-200">
              Rejected
            </div>
          )}
          {isRequestChanges && (
            <div className="absolute right-4 top-4 rounded-full bg-amber-950/90 px-3 py-1.5 text-sm font-medium text-amber-200">
              Changes Requested
            </div>
          )}
        </div>

        {/* Notes input (for rejected or request_changes) */}
        {showNotesInput && (
          <div className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-900/60 px-4 py-2">
            <span className={`shrink-0 text-sm ${isRequestChanges ? 'text-amber-400' : 'text-red-400'}`}>
              {isRequestChanges ? 'Requested changes:' : 'Reason:'}
            </span>
            <input
              ref={notesInputRef}
              type="text"
              value={notesValue}
              onChange={(e) => setNotesValue(e.target.value)}
              onBlur={() => void handleSaveNotes()}
              maxLength={300}
              placeholder={isRequestChanges ? 'Describe changes needed...' : 'Optional rejection reason...'}
              className={`flex-1 rounded-lg border bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none ${
                isRequestChanges ? 'border-zinc-700 focus:border-amber-500' : 'border-zinc-700 focus:border-red-500'
              }`}
            />
            {isRequestChanges && fixImageHref && (
              <a
                href={fixImageHref}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500"
              >
                <Wand2 className="w-3.5 h-3.5" />
                Fix
              </a>
            )}
          </div>
        )}

        {actionNotice && (
          <div
            className={`border-t px-4 py-3 ${
              actionNotice.type === 'error'
                ? 'border-red-900/30 bg-red-950/20'
                : 'border-emerald-900/30 bg-emerald-950/20'
            }`}
            role="status"
            aria-live="polite"
          >
            <div
              className={`flex items-start gap-2 text-sm ${
                actionNotice.type === 'error' ? 'text-red-200' : 'text-emerald-200'
              }`}
            >
              <AlertCircle
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  actionNotice.type === 'error' ? 'text-red-400' : 'text-emerald-400'
                }`}
              />
              <span>{actionNotice.message}</span>
            </div>
          </div>
        )}

        {/* Footer toolbar */}
        <div className="flex flex-col items-stretch justify-between gap-2 rounded-b-xl bg-zinc-900/80 px-3 py-2 sm:flex-row sm:items-center sm:px-4 sm:py-3">
          {/* Thumbnail strip */}
          <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1 sm:max-w-[50%]">
            {thumbnailItems.map((item) => (
              <LightboxThumbnailButton
                key={item.id}
                id={item.id}
                thumbUrl={item.thumbUrl}
                index={item.index}
                isActive={item.isActive}
                approvalStatus={item.approvalStatus}
                onNavigate={onNavigate}
              />
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleApprove}
              disabled={isUpdating}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors sm:gap-2 sm:px-4 sm:py-2 ${
                isApproved
                  ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'bg-zinc-700 text-zinc-200 hover:bg-emerald-600 hover:text-white'
              }`}
              title="Approve (Enter or A)"
            >
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span className="hidden sm:inline">Approve</span>
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={isUpdating}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors sm:gap-2 sm:px-4 sm:py-2 ${
                isRejected
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-zinc-700 text-zinc-200 hover:bg-red-600 hover:text-white'
              }`}
              title="Reject (R)"
            >
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
              <span className="hidden sm:inline">Reject</span>
            </button>
            <button
              type="button"
              onClick={handleRequestChanges}
              disabled={isUpdating}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors sm:gap-2 sm:px-4 sm:py-2 ${
                isRequestChanges
                  ? 'bg-amber-600 text-white hover:bg-amber-500'
                  : 'bg-zinc-700 text-zinc-200 hover:bg-amber-600 hover:text-white'
              }`}
              title="Request Changes (C)"
            >
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
              <span className="hidden sm:inline">Changes</span>
            </button>
            {isRejected && onDelete && (
              <button
                type="button"
                onClick={handlePermanentDelete}
                disabled={isUpdating}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 font-medium text-zinc-200 transition-colors hover:bg-red-800 hover:text-white sm:gap-2 sm:px-4 sm:py-2"
                title="Permanently Delete (Delete/Backspace)"
              >
                {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}
            {projectId && currentImage.productId && currentImage.prompt && (
              <a
                href={buildRegenerateUrl(projectId, currentImage)}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 font-medium text-zinc-200 transition-colors hover:bg-blue-600 hover:text-white sm:gap-2 sm:px-4 sm:py-2"
                title="Regenerate with this prompt"
              >
                <RefreshCw className="w-4 h-4" />
                <span className="hidden sm:inline">Regenerate</span>
              </a>
            )}
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 font-medium text-zinc-200 transition-colors hover:bg-blue-600 hover:text-white sm:gap-2 sm:px-4 sm:py-2"
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
