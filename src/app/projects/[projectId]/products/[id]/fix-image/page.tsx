'use client'

import { use, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import { ReferenceImagePicker } from '../generate/_components/ReferenceImagePicker'
import {
  Wand2,
  Loader2,
  X,
  ChevronDown,
  Image as ImageIcon,
  Play,
  AlertTriangle,
  Upload,
} from 'lucide-react'
import type { GeneratedImage } from '@/lib/types'

export default function FixImagePage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id: productId } = use(params)
  const searchParams = useSearchParams()
  const sourceImageIdParam = searchParams.get('sourceImageId')

  const {
    referenceSets,
    currentJob,
    currentProduct,
    fetchReferenceSets,
    startGeneration,
    fetchJobStatus,
    updateImageApproval,
    deleteImage,
  } = useAppStore()

  // Source image state
  const [sourceImageId, setSourceImageId] = useState<string | null>(null)
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null)
  const [sourceImageLoading, setSourceImageLoading] = useState(false)
  const [showSourcePicker, setShowSourcePicker] = useState(false)

  // Supplemental reference images
  const [refImages, setRefImages] = useState<{ id: string; thumbUrl: string | null }[]>([])
  const [showRefPicker, setShowRefPicker] = useState(false)

  // Change description
  const [changeDescription, setChangeDescription] = useState('')

  // Settings
  const [variationCountInput, setVariationCountInput] = useState('4')
  const [resolution, setResolution] = useState('2K')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [selectedRefSetId, setSelectedRefSetId] = useState<string>('')
  const [didInitDefaults, setDidInitDefaults] = useState(false)

  // Generation state
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, { signed_url?: string | null; thumb_signed_url?: string | null; preview_signed_url?: string | null; expires_at?: number }>>({})
  const signedUrlsRef = useRef(signedUrlsById)

  useEffect(() => { signedUrlsRef.current = signedUrlsById }, [signedUrlsById])

  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) return cached
    const res = await fetch(`/api/images/${imageId}/signed`)
    if (!res.ok) return null
    const data = await res.json()
    const next = { ...signedUrlsRef.current, [imageId]: data }
    signedUrlsRef.current = next
    setSignedUrlsById(next)
    return data
  }, [])

  useEffect(() => {
    fetchReferenceSets(productId)
  }, [productId, fetchReferenceSets])

  // Load product defaults
  useEffect(() => {
    if (!currentProduct || currentProduct.id !== productId || didInitDefaults) return
    const defaults = currentProduct.global_style_settings || {}
    if (defaults.default_resolution) setResolution(defaults.default_resolution)
    if (defaults.default_aspect_ratio) setAspectRatio(defaults.default_aspect_ratio)
    setDidInitDefaults(true)
  }, [currentProduct, productId, didInitDefaults])

  // Default to active reference set
  const productSets = referenceSets.filter((rs) => rs.type === 'product' || !rs.type)
  useEffect(() => {
    if (productSets.length > 0 && !selectedRefSetId) {
      const active = productSets.find((rs) => rs.is_active)
      setSelectedRefSetId(active?.id ?? productSets[0].id)
    }
  }, [productSets, selectedRefSetId])

  // Load source image from query param
  useEffect(() => {
    if (!sourceImageIdParam || sourceImageId) return
    setSourceImageLoading(true)
    fetch(`/api/images/${sourceImageIdParam}/signed`)
      .then((r) => r.json())
      .then((data) => {
        setSourceImageId(sourceImageIdParam)
        setSourceImageUrl(data.thumb_signed_url || data.preview_signed_url || data.signed_url || null)
      })
      .catch(() => {})
      .finally(() => setSourceImageLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceImageIdParam])

  // Poll job status
  useEffect(() => {
    if (!activeJobId) return
    const poll = () => { fetchJobStatus(productId, activeJobId) }
    poll()
    pollingRef.current = setInterval(poll, 3000)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [activeJobId, productId, fetchJobStatus])

  // Stop polling when job is done
  useEffect(() => {
    if (
      currentJob &&
      (currentJob.status === 'completed' || currentJob.status === 'failed')
    ) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      setGenerating(false)
    }
  }, [currentJob?.status])

  const parseVariationCount = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 1) return null
    return Math.min(100, parsed)
  }
  const variationCountValue = parseVariationCount(variationCountInput)

  const handleGenerate = async () => {
    if (!changeDescription.trim() || !sourceImageId || !variationCountValue) return
    setGenerating(true)
    try {
      const job = await startGeneration(productId, {
        prompt_text: changeDescription.trim(),
        variation_count: variationCountValue,
        resolution,
        aspect_ratio: aspectRatio,
        reference_set_id: selectedRefSetId || undefined,
        source_image_id: sourceImageId,
      })
      setActiveJobId(job.id)
    } catch {
      setGenerating(false)
    }
  }

  const lightboxImages: LightboxImage[] = useMemo(() => {
    if (!currentJob?.images) return []
    return currentJob.images.map((img) => ({
      id: img.id,
      public_url: img.public_url,
      thumb_public_url: img.thumb_public_url,
      preview_public_url: img.preview_public_url,
      signed_url: signedUrlsById[img.id]?.signed_url ?? null,
      thumb_signed_url: signedUrlsById[img.id]?.thumb_signed_url ?? null,
      preview_signed_url: signedUrlsById[img.id]?.preview_signed_url ?? null,
      file_name: img.storage_path?.split('/').pop() ?? null,
      variation_number: img.variation_number,
      approval_status: img.approval_status ?? 'pending',
      notes: img.notes,
      productId,
    }))
  }, [currentJob?.images, signedUrlsById, productId])

  const handleApprovalChange = async (imageId: string, status: ApprovalStatus) => {
    if (status === 'rejected') {
      await deleteImage(imageId)
    } else {
      await updateImageApproval(imageId, status)
    }
  }

  const completedOrImages = currentJob
    ? Math.max(currentJob.completed_count ?? 0, currentJob.images?.length ?? 0)
    : 0
  const progress =
    currentJob && currentJob.variation_count
      ? Math.round((completedOrImages / currentJob.variation_count) * 100)
      : 0
  const failedCount = currentJob?.failed_count ?? 0
  const hasFailures = failedCount > 0
  const errorMessage = currentJob?.error_message
  const displayStatus = currentJob ? currentJob.status : null

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Wand2 className="h-5 w-5" />
          Fix Image
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Select a source image and describe the changes you want. The AI will recreate the image with your modifications.
        </p>
      </div>

      {/* Source Image */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Source Image <span className="text-red-400">*</span></h2>
        <div className="flex items-start gap-4">
          {sourceImageId && sourceImageUrl ? (
            <div className="relative w-48 h-48 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sourceImageUrl} alt="Source" className="h-full w-full object-cover" />
              <button
                onClick={() => { setSourceImageId(null); setSourceImageUrl(null) }}
                className="absolute top-1 right-1 rounded-full bg-zinc-900/80 border border-zinc-700 p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : sourceImageLoading ? (
            <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
            </div>
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-lg border-2 border-dashed border-zinc-700 bg-zinc-800/50">
              <ImageIcon className="h-10 w-10 text-zinc-600" />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setShowSourcePicker(true)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {sourceImageId ? 'Change Source' : 'Select from Gallery'}
            </button>
            {sourceImageId && (
              <button
                onClick={() => { setSourceImageId(null); setSourceImageUrl(null) }}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Change Description */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Change Description <span className="text-red-400">*</span></h2>
        <textarea
          rows={4}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
          placeholder="Describe what changes you'd like..."
          value={changeDescription}
          onChange={(e) => setChangeDescription(e.target.value)}
        />
      </section>

      {/* Settings */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-300">Settings</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Variations</label>
            <input
              type="number"
              min={1}
              max={100}
              value={variationCountInput}
              onChange={(e) => setVariationCountInput(e.target.value)}
              onBlur={() => {
                const parsed = parseVariationCount(variationCountInput)
                setVariationCountInput(String(parsed ?? 1))
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Resolution</label>
            <div className="relative">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Aspect Ratio</label>
            <div className="relative">
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="9:16">9:16</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
        </div>
      </section>

      {/* Reference Set */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Reference Set</h2>
        {productSets.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-yellow-600 bg-yellow-950/40 px-4 py-3 text-yellow-300 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No product reference sets found.</span>
          </div>
        ) : (
          <div className="relative">
            <select
              value={selectedRefSetId}
              onChange={(e) => setSelectedRefSetId(e.target.value)}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {productSets.map((rs) => (
                <option key={rs.id} value={rs.id}>
                  {rs.name}{rs.is_active ? ' (Active)' : ''}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
        )}
      </section>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={
          !changeDescription.trim() ||
          !sourceImageId ||
          !selectedRefSetId ||
          generating ||
          !variationCountValue
        }
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-6 py-3 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {generating ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Wand2 className="h-5 w-5" />
        )}
        {generating ? 'Fixing...' : 'Fix Image'}
      </button>

      {/* Active Job Monitor */}
      {currentJob && activeJobId && (displayStatus === 'running' || displayStatus === 'pending' || displayStatus === 'completed' || displayStatus === 'failed') && (
        <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-800/30 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Job Progress</h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                displayStatus === 'completed'
                  ? 'bg-green-900/50 text-green-400'
                  : displayStatus === 'failed'
                    ? 'bg-red-900/50 text-red-400'
                    : 'bg-blue-900/50 text-blue-400'
              }`}
            >
              {displayStatus}
            </span>
          </div>

          {errorMessage && (
            <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
              <span className="font-medium">Error:</span> {errorMessage}
            </div>
          )}

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>
                {displayStatus === 'pending' ? (
                  'Starting generation...'
                ) : displayStatus === 'completed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''} — Complete
                  </>
                ) : displayStatus === 'failed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images · {failedCount} failed
                  </>
                ) : completedOrImages === 0 ? (
                  'Generating fixed images...'
                ) : (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''}
                  </>
                )}
              </span>
              {(displayStatus !== 'pending' && !(displayStatus === 'running' && completedOrImages === 0)) && (
                <span>{progress}%</span>
              )}
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
              {displayStatus === 'completed' ? (
                <div className="h-full w-full rounded-full bg-green-500 transition-all duration-500" />
              ) : displayStatus === 'failed' ? (
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-500"
                  style={{ width: `${Math.max(progress, 5)}%` }}
                />
              ) : (displayStatus === 'pending' || (displayStatus === 'running' && completedOrImages === 0)) ? (
                <div className="h-full w-1/3 rounded-full bg-orange-500 animate-pulse-bar" />
              ) : (
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
          </div>

          {/* Generated image thumbnails */}
          {currentJob.images && currentJob.images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {currentJob.images.map((img, index) => (
                <button
                  key={img.id}
                  onClick={() => setLightboxIndex(index)}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 hover:border-zinc-500 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500"
                >
                  {(img.thumb_public_url || img.public_url) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img.thumb_public_url || img.public_url || ''}
                      alt=""
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon className="h-6 w-6 text-zinc-600" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          projectId={projectId}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}

      {/* Source Image Picker Modal — shows ALL images (not just approved) */}
      <SourceImagePicker
        isOpen={showSourcePicker}
        onClose={() => setShowSourcePicker(false)}
        onSelect={(imageId, thumbUrl) => {
          setSourceImageId(imageId)
          setSourceImageUrl(thumbUrl)
          setShowSourcePicker(false)
        }}
        productId={productId}
      />
    </div>
  )
}

// Source image picker that shows ALL images (not just approved)
function SourceImagePicker({
  isOpen,
  onClose,
  onSelect,
  productId,
}: {
  isOpen: boolean
  onClose: () => void
  onSelect: (imageId: string, thumbUrl: string | null) => void
  productId: string
}) {
  const [tab, setTab] = useState<'gallery' | 'upload'>('gallery')
  const [galleryImages, setGalleryImages] = useState<GeneratedImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setTab('gallery')
    setLoadingGallery(true)
    // Fetch ALL images (no approval filter) for source selection
    fetch(`/api/products/${productId}/gallery?media_type=image`)
      .then((r) => r.json())
      .then((data) => setGalleryImages(data.images ?? data))
      .catch(() => setGalleryImages([]))
      .finally(() => setLoadingGallery(false))
  }, [isOpen, productId])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await fetch(`/api/products/${productId}/gallery/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{
            file_name: file.name,
            mime_type: file.type,
            file_size: file.size,
          }],
        }),
      })
      if (!res.ok) throw new Error('Upload request failed')
      const results = await res.json()
      const firstResult = Array.isArray(results) ? results[0] : null
      if (!firstResult || firstResult.error || !firstResult.signed_url || !firstResult.image?.id) {
        throw new Error(firstResult?.error || 'Failed to prepare upload')
      }
      await fetch(firstResult.signed_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      onSelect(firstResult.image.id, firstResult.image.thumb_public_url || firstResult.image.public_url || null)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <div className="relative w-full max-w-2xl mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-200">Select Source Image</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:text-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex gap-2 mb-4 border-b border-zinc-700 pb-2">
          <button
            onClick={() => setTab('gallery')}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${tab === 'gallery' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Gallery
          </button>
          <button
            onClick={() => setTab('upload')}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${tab === 'upload' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Upload
          </button>
        </div>

        {tab === 'gallery' ? (
          <div className="max-h-80 overflow-y-auto">
            {loadingGallery ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
              </div>
            ) : galleryImages.length === 0 ? (
              <p className="text-center text-sm text-zinc-500 py-8">No images in gallery.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {galleryImages.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => onSelect(img.id, img.thumb_public_url || img.public_url || null)}
                    className={`h-24 overflow-hidden rounded-lg border bg-zinc-800 hover:border-blue-500 transition-colors ${
                      img.approval_status === 'request_changes'
                        ? 'border-orange-600/60'
                        : img.approval_status === 'rejected'
                          ? 'border-red-600/60'
                          : 'border-zinc-700'
                    }`}
                  >
                    {(img.thumb_public_url || img.public_url) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={(img.thumb_public_url || img.public_url)!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <ImageIcon className="h-6 w-6 text-zinc-600" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 flex flex-col items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleUpload}
              className="hidden"
            />
            {uploading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin" />
                Uploading...
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 px-12 py-8 text-zinc-400 hover:border-blue-500 hover:text-blue-400 transition-colors"
              >
                <Upload className="h-8 w-8" />
                <span className="text-sm font-medium">Click to upload an image</span>
                <span className="text-xs text-zinc-500">PNG, JPG, WebP</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
