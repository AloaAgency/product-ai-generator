'use client'

import { use, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import { GalleryContextMenu, type ContextMenuAction } from '@/components/GalleryContextMenu'
import { VirtualizedSquareGrid } from '@/components/VirtualizedSquareGrid'
import type { PromptTemplate } from '@/lib/types'
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  Download,
  ImageIcon,
  Loader2,
  Layers,
  Video,
  Play,
  X,
  Upload,
  Trash2,
  CheckSquare,
  Square,
  Check,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'request_changes'
type SortOption = 'newest' | 'oldest' | 'variation'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Changes', value: 'request_changes' },
]

type SignedImageUrls = {
  signed_url: string | null
  download_url: string | null
  thumb_signed_url: string | null
  preview_signed_url: string | null
  expires_at: number
}

export default function GalleryPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id } = use(params)
  const router = useRouter()

  const products = useAppStore((state) => state.products)
  const fetchProducts = useAppStore((state) => state.fetchProducts)
  const galleryImages = useAppStore((state) => state.galleryImages)
  const galleryTotal = useAppStore((state) => state.galleryTotal)
  const galleryHasMore = useAppStore((state) => state.galleryHasMore)
  const loadingGallery = useAppStore((state) => state.loadingGallery)
  const loadingGalleryMore = useAppStore((state) => state.loadingGalleryMore)
  const fetchGallery = useAppStore((state) => state.fetchGallery)
  const fetchGalleryMore = useAppStore((state) => state.fetchGalleryMore)
  const updateImageApproval = useAppStore((state) => state.updateImageApproval)
  const deleteImage = useAppStore((state) => state.deleteImage)
  const bulkDeleteImages = useAppStore((state) => state.bulkDeleteImages)
  const fetchGenerationJobs = useAppStore((state) => state.fetchGenerationJobs)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all')
  const [jobFilter, setJobFilter] = useState<string>('all')
  const [sortOption, setSortOption] = useState<SortOption>('newest')
  const [groupByScene, setGroupByScene] = useState(false)
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const signedUrlsRef = useRef(signedUrlsById)
  const signedUrlRequestsRef = useRef<Record<string, Promise<SignedImageUrls | null>>>({})
  const batchSignedUrlRequestsRef = useRef<Record<string, Promise<Record<string, SignedImageUrls>>>>({})

  const [uploadingGallery, setUploadingGallery] = useState(false)
  const galleryFileInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; imageId: string; approvalStatus: string | null } | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    signedUrlsRef.current = signedUrlsById
  }, [signedUrlsById])

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && galleryHasMore && !loadingGalleryMore) {
          fetchGalleryMore(id, { sort: sortOption })
        }
      },
      { rootMargin: '400px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [galleryHasMore, loadingGalleryMore, fetchGalleryMore, id, sortOption])

  async function handleGalleryUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    setUploadingGallery(true)
    try {
      const files = Array.from(fileList).map((f) => ({
        file_name: f.name,
        mime_type: f.type,
        file_size: f.size,
      }))
      const res = await fetch(`/api/products/${id}/gallery/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      })
      if (!res.ok) throw new Error('Upload request failed')
      const results = await res.json()

      // Upload each file to its signed URL
      const fileArray = Array.from(fileList)
      const uploadedImageIds: string[] = []
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (!result.signed_url) continue
        const file = fileArray[i]
        await fetch(result.signed_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (result.image?.id) uploadedImageIds.push(result.image.id)
      }
      // Generate thumbnails for uploaded images
      if (uploadedImageIds.length > 0) {
        await fetch('/api/images/generate-thumbs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_ids: uploadedImageIds }),
        }).catch(() => {})
      }
      // Refresh gallery
      await fetchGallery(id, { sort: sortOption })
    } catch (err) {
      console.error('[GalleryUpload] Error:', err)
    } finally {
      setUploadingGallery(false)
      if (galleryFileInputRef.current) galleryFileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    fetchGallery(id, { sort: sortOption })
    fetchGenerationJobs(id)
    fetch(`/api/products/${id}/prompts`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setPromptTemplates(data) })
      .catch(() => {})
  }, [id, sortOption, fetchGallery, fetchGenerationJobs])

  useEffect(() => {
    fetchProducts(projectId)
  }, [projectId, fetchProducts])

  const projectProducts = useMemo(
    () => products.filter((p) => p.project_id === projectId),
    [products, projectId]
  )
  const currentProductIndex = useMemo(
    () => projectProducts.findIndex((p) => p.id === id),
    [projectProducts, id]
  )
  const prevProductId = currentProductIndex > 0 ? projectProducts[currentProductIndex - 1].id : null
  const nextProductId =
    currentProductIndex >= 0 && currentProductIndex < projectProducts.length - 1
      ? projectProducts[currentProductIndex + 1].id
      : null

  const navigateToProduct = useCallback(
    (productId: string) => {
      if (productId && productId !== id) {
        router.push(`/projects/${projectId}/products/${productId}/gallery`)
      }
    },
    [router, projectId, id]
  )

  // Unique job IDs for filter dropdown
  const jobIds = useMemo(() => {
    const ids = Array.from(
      new Set(
        galleryImages
          .map((img) => img.job_id)
          .filter((id): id is string => Boolean(id))
      )
    )
    return ids
  }, [galleryImages])

  // Filtered images
  const filteredImages = useMemo(() => {
    return galleryImages.filter((img) => {
      if (statusFilter !== 'all') {
        const imgStatus = img.approval_status ?? 'pending'
        if (imgStatus !== statusFilter) return false
      }
      if (mediaFilter !== 'all') {
        const mt = (img as unknown as Record<string, unknown>).media_type as string || 'image'
        if (mt !== mediaFilter) return false
      }
      if (jobFilter !== 'all' && img.job_id !== jobFilter) return false
      return true
    })
  }, [galleryImages, statusFilter, mediaFilter, jobFilter])

  // Count of rejected images (always from full gallery, not filtered)
  const rejectedCount = useMemo(() => {
    return galleryImages.filter((img) => img.approval_status === 'rejected').length
  }, [galleryImages])

  const requestChangesCount = useMemo(() => {
    return galleryImages.filter((img) => img.approval_status === 'request_changes').length
  }, [galleryImages])

  // Build a template lookup map
  const templateMap = useMemo(() => {
    const map = new Map<string, PromptTemplate>()
    for (const t of promptTemplates) map.set(t.id, t)
    return map
  }, [promptTemplates])

  const imageOnly = useMemo(
    () => filteredImages.filter((img) => (img as unknown as Record<string, unknown>).media_type !== 'video'),
    [filteredImages]
  )

  const imageIndexById = useMemo(() => {
    const indexMap = new Map<string, number>()
    imageOnly.forEach((img, index) => {
      indexMap.set(img.id, index)
    })
    return indexMap
  }, [imageOnly])

  // Group images by scene (prompt_template_id)
  const sceneGroups = useMemo(() => {
    if (!groupByScene || mediaFilter === 'video') return null
    const groups = new Map<string, typeof imageOnly>()
    for (const img of imageOnly) {
      const key = (img as unknown as Record<string, unknown>).prompt_template_id as string | null ?? '__ungrouped__'
      const arr = groups.get(key)
      if (arr) arr.push(img)
      else groups.set(key, [img])
    }
    return Array.from(groups.entries()).map(([templateId, images]) => {
      const template = templateId !== '__ungrouped__' ? templateMap.get(templateId) : null
      return {
        templateId,
        title: template?.scene_title ?? template?.name ?? 'Ungrouped',
        images,
      }
    })
  }, [groupByScene, mediaFilter, imageOnly, templateMap])

  // Map to lightbox format
  const lightboxImages: LightboxImage[] = useMemo(() => {
    return imageOnly.map((img) => {
      const imgAny = img as unknown as Record<string, unknown>
      return {
        id: img.id,
        public_url: img.public_url,
        thumb_public_url: img.thumb_public_url,
        preview_public_url: img.preview_public_url,
        signed_url: signedUrlsById[img.id]?.signed_url ?? null,
        download_url: signedUrlsById[img.id]?.download_url ?? null,
        thumb_signed_url: signedUrlsById[img.id]?.thumb_signed_url ?? null,
        preview_signed_url: signedUrlsById[img.id]?.preview_signed_url ?? null,
        file_name: img.storage_path?.split('/').pop() ?? null,
        variation_number: img.variation_number,
        approval_status: img.approval_status ?? 'pending',
        notes: img.notes,
        prompt: img.prompt ?? null,
        productId: id,
        // Job settings for regeneration
        reference_set_id: (imgAny.reference_set_id as string) ?? null,
        texture_set_id: (imgAny.texture_set_id as string) ?? null,
        product_image_count: (imgAny.product_image_count as number) ?? null,
        texture_image_count: (imgAny.texture_image_count as number) ?? null,
      }
    })
  }, [imageOnly, signedUrlsById, id])

  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) {
      return cached
    }

    const inFlight = signedUrlRequestsRef.current[imageId]
    if (inFlight) return inFlight

    const request = fetch(`/api/images/${imageId}/signed`)
      .then(async (res) => {
        if (!res.ok) return null
        const data = (await res.json()) as SignedImageUrls
        const next = { ...signedUrlsRef.current, [imageId]: data }
        signedUrlsRef.current = next
        setSignedUrlsById(next)
        return data
      })
      .finally(() => {
        delete signedUrlRequestsRef.current[imageId]
      })

    signedUrlRequestsRef.current[imageId] = request
    return request
  }, [])

  const ensureSignedUrlsBatch = useCallback(async (imageIds: string[]) => {
    const pendingIds = Array.from(new Set(imageIds)).filter((imageId) => {
      const cached = signedUrlsRef.current[imageId]
      return !(cached?.expires_at && cached.expires_at - Date.now() > 60_000)
    })
    if (pendingIds.length === 0) return {}

    const requestKey = pendingIds.slice().sort().join(',')
    const inFlight = batchSignedUrlRequestsRef.current[requestKey]
    if (inFlight) return inFlight

    const request = fetch('/api/images/signed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids: pendingIds }),
    })
      .then(async (res) => {
        if (!res.ok) return {}
        const data = await res.json() as { signed_urls?: Record<string, SignedImageUrls> }
        const updates = data.signed_urls ?? {}
        if (Object.keys(updates).length > 0) {
          const next = { ...signedUrlsRef.current, ...updates }
          signedUrlsRef.current = next
          setSignedUrlsById(next)
        }
        return updates
      })
      .finally(() => {
        delete batchSignedUrlRequestsRef.current[requestKey]
      })

    batchSignedUrlRequestsRef.current[requestKey] = request
    return request
  }, [])

  useEffect(() => {
    if (lightboxIndex !== null) return
    if (imageOnly.length === 0) return

    const warmIds = imageOnly.slice(0, 6).map((img) => img.id)
    const timeout = window.setTimeout(() => {
      void ensureSignedUrlsBatch(warmIds)
    }, 150)

    return () => window.clearTimeout(timeout)
  }, [ensureSignedUrlsBatch, imageOnly, lightboxIndex])

  const warmLightboxAssets = useCallback((imageId: string) => {
    const index = imageIndexById.get(imageId)
    if (index === undefined) return

    const warmIndexes = [index, index - 1, index + 1, index + 2]
    const warmIds = warmIndexes
      .map((warmIndex) => imageOnly[warmIndex]?.id)
      .filter((value): value is string => Boolean(value))
    if (warmIds.length > 0) {
      void ensureSignedUrlsBatch(warmIds)
    }
  }, [ensureSignedUrlsBatch, imageIndexById, imageOnly])

  useModalShortcuts({
    isOpen: !!playingVideoUrl,
    onClose: () => setPlayingVideoUrl(null),
  })

  const handleApprovalChange = async (imageId: string, status: ApprovalStatus, notes?: string) => {
    await updateImageApproval(imageId, status, notes)
  }

  const handleDelete = useCallback(async (imageId: string) => {
    await deleteImage(imageId)
    // Adjust lightbox after deletion
    if (lightboxIndex !== null) {
      const newFiltered = imageOnly.filter((img) => img.id !== imageId)
      if (newFiltered.length === 0) {
        setLightboxIndex(null)
      } else if (lightboxIndex >= newFiltered.length) {
        setLightboxIndex(newFiltered.length - 1)
      }
    }
  }, [deleteImage, imageOnly, lightboxIndex])

  const handleContextMenuAction = useCallback(async (action: ContextMenuAction, imageId: string) => {
    const img = galleryImages.find((i) => i.id === imageId)
    if (!img) return

    switch (action) {
      case 'open': {
        const idx = imageIndexById.get(imageId) ?? -1
        if (idx !== -1) setLightboxIndex(idx)
        break
      }
      case 'approve':
        await updateImageApproval(imageId, img.approval_status === 'approved' ? null : 'approved')
        break
      case 'reject':
        await updateImageApproval(imageId, img.approval_status === 'rejected' ? null : 'rejected')
        break
      case 'request_changes':
        await updateImageApproval(imageId, img.approval_status === 'request_changes' ? null : 'request_changes')
        break
      case 'download': {
        const signed = await ensureSignedUrls(imageId)
        const url = signed?.download_url || signed?.signed_url || img.public_url
        if (!url) break
        try {
          const fileName = img.storage_path?.split('/').pop() ?? `product-gen-${img.variation_number || 0}.png`
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
        } catch (err) {
          console.error('Download failed for image', imageId, err)
        }
        break
      }
      case 'delete':
        if (img.approval_status === 'rejected') {
          if (window.confirm('Permanently delete this image? This cannot be undone.')) {
            await handleDelete(imageId)
          }
        }
        break
    }
  }, [galleryImages, imageIndexById, updateImageApproval, ensureSignedUrls, handleDelete])

  const toggleSelectMode = () => {
    setSelectMode((v) => {
      if (v) setSelectedIds(new Set())
      return !v
    })
  }

  const toggleImageSelection = (imageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(imageId)) next.delete(imageId)
      else next.add(imageId)
      return next
    })
  }

  const handleBulkDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!window.confirm(`Permanently delete ${selectedIds.size} image${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      await bulkDeleteImages(Array.from(selectedIds))
      await fetchGallery(id, { sort: sortOption })
      setSelectedIds(new Set())
      setSelectMode(false)
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleBulkDelete = async () => {
    const rejectedIds = galleryImages
      .filter((img) => img.approval_status === 'rejected')
      .map((img) => img.id)
    if (rejectedIds.length === 0) return
    if (!window.confirm(`Permanently delete ${rejectedIds.length} rejected image${rejectedIds.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      await bulkDeleteImages(rejectedIds)
      await fetchGallery(id, { sort: sortOption })
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleDownloadApproved = async () => {
    const approved = galleryImages.filter((img) => img.approval_status === 'approved')
    for (const img of approved) {
      const signed = await ensureSignedUrls(img.id)
      const url = signed?.download_url || signed?.signed_url || img.public_url
      if (!url) continue
      try {
        const fileName = img.storage_path?.split('/').pop() ?? `product-gen-${img.variation_number || 0}.png`
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
        await new Promise((resolve) => setTimeout(resolve, 300))
      } catch (err) {
        console.error('Download failed for image', img.id, err)
      }
    }
  }

  useEffect(() => {
    let isMounted = true
    let prevHadActive = false

    const hasActiveJobs = () => {
      const { generationJobs } = useAppStore.getState()
      return generationJobs.some((job) => job.status === 'pending' || job.status === 'running')
    }

    const poll = async () => {
      await fetchGenerationJobs(id)
      const hasActive = hasActiveJobs()
      if (!isMounted) return
      if (hasActive) {
        await fetchGallery(id, { sort: sortOption })
      } else if (prevHadActive && !hasActive) {
        await fetchGallery(id, { sort: sortOption })
      }
      prevHadActive = hasActive
    }

    const interval = setInterval(() => {
      void poll()
    }, 5000)

    void poll()

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [id, sortOption, fetchGallery, fetchGenerationJobs])

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds(new Set())
    setSelectMode(false)
  }, [statusFilter, mediaFilter, jobFilter, sortOption])

  useEffect(() => {
    if (lightboxIndex === null) return
    const warmIndexes = [lightboxIndex, lightboxIndex - 1, lightboxIndex + 1, lightboxIndex - 2, lightboxIndex + 2]
    const warmIds = warmIndexes
      .map((index) => imageOnly[index]?.id)
      .filter((value): value is string => Boolean(value))
    if (warmIds.length > 0) {
      void ensureSignedUrlsBatch(warmIds)
    }
  }, [ensureSignedUrlsBatch, imageOnly, lightboxIndex])

  const statusBadge = (status: string | null) => {
    switch (status) {
      case 'approved':
        return (
          <span className="absolute top-2 right-2 rounded-full bg-green-600 px-2 py-0.5 text-xs font-medium text-white">
            Approved
          </span>
        )
      case 'rejected':
        return (
          <span className="absolute top-2 right-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">
            Rejected
          </span>
        )
      case 'request_changes':
        return (
          <span className="absolute top-2 right-2 rounded-full bg-orange-600 px-2 py-0.5 text-xs font-medium text-white">
            Changes
          </span>
        )
      default:
        return (
          <span className="absolute top-2 right-2 rounded-full bg-zinc-600 px-2 py-0.5 text-xs font-medium text-zinc-300">
            Pending
          </span>
        )
    }
  }

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${projectId}/products/${id}`}
              className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <button
              type="button"
              onClick={() => prevProductId && navigateToProduct(prevProductId)}
              disabled={!prevProductId}
              aria-label="Previous product"
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            {projectProducts.length > 0 && currentProductIndex !== -1 ? (
              <select
                value={id}
                onChange={(e) => navigateToProduct(e.target.value)}
                className="max-w-[260px] truncate rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-base font-semibold text-zinc-100 outline-none focus:border-zinc-500"
              >
                {projectProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <h1 className="text-xl font-semibold">Image Gallery</h1>
            )}
            <button
              type="button"
              onClick={() => nextProductId && navigateToProduct(nextProductId)}
              disabled={!nextProductId}
              aria-label="Next product"
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
              {galleryTotal > filteredImages.length ? `${filteredImages.length} of ${galleryTotal}` : filteredImages.length} image{galleryTotal !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={galleryFileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleGalleryUpload}
              className="hidden"
            />
            <button
              onClick={() => galleryFileInputRef.current?.click()}
              disabled={uploadingGallery}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
            >
              {uploadingGallery ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload Images
            </button>
            <button
              onClick={handleDownloadApproved}
              disabled={!galleryImages.some((img) => img.approval_status === 'approved')}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Download className="h-4 w-4" />
              Download Approved
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="border-b border-zinc-800 px-4 sm:px-6 py-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1.5">
            <Filter className="h-4 w-4 text-zinc-500" />
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  statusFilter === f.value
                    ? f.value === 'rejected'
                      ? 'bg-red-600 text-white'
                      : f.value === 'request_changes'
                        ? 'bg-orange-600 text-white'
                        : 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {f.label}
                {f.value === 'rejected' && rejectedCount > 0 && statusFilter !== 'rejected' && (
                  <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white min-w-[18px]">
                    {rejectedCount}
                  </span>
                )}
                {f.value === 'request_changes' && requestChangesCount > 0 && statusFilter !== 'request_changes' && (
                  <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-orange-600 px-1.5 text-[10px] font-bold text-white min-w-[18px]">
                    {requestChangesCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="mx-2 hidden sm:block h-5 w-px bg-zinc-700" />

          <div className="flex items-center gap-1.5">
            {([
              { label: 'All', value: 'all' as const, icon: null },
              { label: 'Images', value: 'image' as const, icon: ImageIcon },
              { label: 'Videos', value: 'video' as const, icon: Video },
            ]).map((f) => (
              <button
                key={f.value}
                onClick={() => setMediaFilter(f.value)}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  mediaFilter === f.value
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {f.icon && <f.icon className="h-3.5 w-3.5" />}
                {f.label}
              </button>
            ))}
          </div>

          <div className="mx-2 hidden sm:block h-5 w-px bg-zinc-700" />

          <button
            onClick={() => setGroupByScene((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              groupByScene
                ? 'bg-zinc-100 text-zinc-900'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            Group by Scene
          </button>

          <button
            onClick={toggleSelectMode}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              selectMode
                ? 'bg-blue-600 text-white'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            Select
          </button>

          <div className="mx-2 hidden sm:block h-5 w-px bg-zinc-700" />

          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="h-4 w-4 text-zinc-500" />
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as SortOption)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
            >
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="variation">Variation #</option>
            </select>
          </div>

          {jobIds.length > 1 && (
            <select
              value={jobFilter}
              onChange={(e) => setJobFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
            >
              <option value="all">All Jobs</option>
              {jobIds.map((jid) => (
                <option key={jid} value={jid}>
                  Job {jid.slice(0, 8)}...
                </option>
              ))}
            </select>
          )}

          {statusFilter === 'rejected' && rejectedCount > 0 && (
            <>
              <div className="mx-2 hidden sm:block h-5 w-px bg-zinc-700" />
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40 transition-colors"
              >
                {bulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete All Rejected
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {loadingGallery ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
        </div>
      ) : filteredImages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 text-zinc-500">
          <ImageIcon className="mb-4 h-16 w-16" />
          <p className="text-lg font-medium">No images found</p>
          <p className="mt-1 text-sm">
            {statusFilter === 'rejected'
              ? 'No rejected images to review.'
              : statusFilter === 'request_changes'
                ? 'No images with requested changes.'
                : galleryImages.length === 0
                  ? 'Generate some images to see them here.'
                  : 'Try adjusting your filters.'}
          </p>
        </div>
      ) : sceneGroups ? (
          <div className="space-y-8 px-4 sm:px-6 py-6">
            {sceneGroups.map((group) => (
              <div key={group.templateId}>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-zinc-200">{group.title}</h2>
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {group.images.length}
                  </span>
                </div>
                <VirtualizedSquareGrid
                  items={group.images}
                  getItemKey={(img) => img.id}
                  renderItem={(img) => {
                    const globalIndex = imageIndexById.get(img.id) ?? -1
                    const isRejected = img.approval_status === 'rejected'
                    const isChanges = img.approval_status === 'request_changes'
                    const isSelected = selectedIds.has(img.id)
                    return (
                      <button
                        key={img.id}
                        onClick={() => {
                          if (selectMode) {
                            toggleImageSelection(img.id)
                          } else if (globalIndex !== -1) {
                            setLightboxIndex(globalIndex)
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setContextMenu({ x: e.clientX, y: e.clientY, imageId: img.id, approvalStatus: img.approval_status })
                        }}
                        onMouseEnter={() => warmLightboxAssets(img.id)}
                        onFocus={() => warmLightboxAssets(img.id)}
                        className={`group relative aspect-square overflow-hidden rounded-lg border bg-zinc-800 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 ${
                          isSelected
                            ? 'border-blue-500 ring-2 ring-blue-500'
                            : isRejected
                              ? 'border-red-600/60 hover:border-red-500'
                              : isChanges
                                ? 'border-orange-600/60 hover:border-orange-500'
                                : 'border-zinc-800 hover:border-zinc-600'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.thumb_public_url ?? img.preview_public_url ?? img.public_url ?? undefined}
                          alt={`Variation ${img.variation_number}`}
                          loading="lazy"
                          decoding="async"
                          className={`h-full w-full object-cover transition-transform group-hover:scale-105 ${isRejected || isChanges ? 'opacity-60' : ''}`}
                        />
                        {selectMode && (
                          <div className="absolute top-2 left-2 z-10">
                            {isSelected ? (
                              <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-500">
                                <Check className="h-3.5 w-3.5 text-white" />
                              </div>
                            ) : (
                              <Square className="h-5 w-5 text-white drop-shadow" />
                            )}
                          </div>
                        )}
                        {statusBadge(img.approval_status)}
                        {isRejected && img.notes && (
                          <div className="absolute bottom-0 inset-x-0 bg-black/70 px-2 py-1">
                            <p className="text-[10px] text-red-300 truncate">{img.notes}</p>
                          </div>
                        )}
                        {isChanges && img.notes && (
                          <div className="absolute bottom-0 inset-x-0 bg-black/70 px-2 py-1">
                            <p className="text-[10px] text-orange-300 truncate">{img.notes}</p>
                          </div>
                        )}
                      </button>
                    )
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-6 sm:px-6">
            <VirtualizedSquareGrid
              items={filteredImages}
              getItemKey={(img) => img.id}
              renderItem={(img) => {
                const isVideo = (img as unknown as Record<string, unknown>).media_type === 'video'
                const isRejected = img.approval_status === 'rejected'
                const isChanges = img.approval_status === 'request_changes'
                const imageIndex = imageIndexById.get(img.id) ?? -1
                const isSelected = selectedIds.has(img.id)
                return (
                  <button
                    key={img.id}
                    onClick={() => {
                      if (selectMode) {
                        toggleImageSelection(img.id)
                      } else if (isVideo && img.public_url) {
                        setPlayingVideoUrl(img.public_url)
                      } else {
                        if (imageIndex !== -1) setLightboxIndex(imageIndex)
                      }
                    }}
                    onContextMenu={(e) => {
                      if (isVideo) return
                      e.preventDefault()
                      setContextMenu({ x: e.clientX, y: e.clientY, imageId: img.id, approvalStatus: img.approval_status })
                    }}
                    onMouseEnter={() => {
                      if (!isVideo) warmLightboxAssets(img.id)
                    }}
                    onFocus={() => {
                      if (!isVideo) warmLightboxAssets(img.id)
                    }}
                    className={`group relative aspect-square overflow-hidden rounded-lg border bg-zinc-800 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 ${
                      isSelected
                        ? 'border-blue-500 ring-2 ring-blue-500'
                        : isRejected
                          ? 'border-red-600/60 hover:border-red-500'
                          : isChanges
                            ? 'border-orange-600/60 hover:border-orange-500'
                            : 'border-zinc-800 hover:border-zinc-600'
                    }`}
                  >
                    {isVideo ? (
                      <>
                        {img.thumb_public_url ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={img.thumb_public_url}
                            alt="Video thumbnail"
                            loading="lazy"
                            decoding="async"
                            className={`h-full w-full object-cover ${isRejected || isChanges ? 'opacity-60' : ''}`}
                          />
                        ) : (
                          <video
                            src={`${img.public_url}#t=0.1`}
                            preload="metadata"
                            muted
                            playsInline
                            className={`h-full w-full object-cover ${isRejected || isChanges ? 'opacity-60' : ''}`}
                          />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="rounded-full bg-black/50 p-3">
                            <Play className="h-6 w-6 text-white fill-white" />
                          </div>
                        </div>
                      </>
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={img.thumb_public_url ?? img.preview_public_url ?? img.public_url ?? undefined}
                        alt={`Variation ${img.variation_number}`}
                        loading="lazy"
                        decoding="async"
                        className={`h-full w-full object-cover transition-transform group-hover:scale-105 ${isRejected || isChanges ? 'opacity-60' : ''}`}
                      />
                    )}
                    {selectMode && (
                      <div className="absolute top-2 left-2 z-10">
                        {isSelected ? (
                          <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-500">
                            <Check className="h-3.5 w-3.5 text-white" />
                          </div>
                        ) : (
                          <Square className="h-5 w-5 text-white drop-shadow" />
                        )}
                      </div>
                    )}
                    {isVideo && (
                      <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-purple-600/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        <Video className="h-3 w-3" /> Video
                      </span>
                    )}
                    {statusBadge(img.approval_status)}
                    {isRejected && img.notes && (
                      <div className="absolute bottom-0 inset-x-0 bg-black/70 px-2 py-1">
                        <p className="text-[10px] text-red-300 truncate">{img.notes}</p>
                      </div>
                    )}
                    {isChanges && img.notes && (
                      <div className="absolute bottom-0 inset-x-0 bg-black/70 px-2 py-1">
                        <p className="text-[10px] text-orange-300 truncate">{img.notes}</p>
                      </div>
                    )}
                  </button>
                )
              }}
            />
          </div>
        )
      }

      {/* Infinite scroll sentinel */}
      {!loadingGallery && galleryHasMore && (
        <div ref={loadMoreRef} className="flex items-center justify-center py-8">
          {loadingGalleryMore && <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />}
        </div>
      )}

      {/* Selection action bar */}
      {selectMode && selectedIds.size > 0 && (
        <div className="sticky bottom-0 z-40 border-t border-zinc-700 bg-zinc-800/95 backdrop-blur px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-200">
              {selectedIds.size} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const allIds = new Set(filteredImages.map((img) => img.id))
                  setSelectedIds(allIds)
                }}
                className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                Select All
              </button>
              <button
                onClick={handleBulkDeleteSelected}
                disabled={bulkDeleting}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40 transition-colors"
              >
                {bulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete Selected
              </button>
              <button
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }}
                className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Video playback overlay */}
      {playingVideoUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setPlayingVideoUrl(null)}>
          <div className="relative w-full max-w-4xl mx-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPlayingVideoUrl(null)}
              className="absolute -top-10 right-0 rounded p-1 text-zinc-400 hover:text-zinc-100"
            >
              <X className="h-6 w-6" />
            </button>
            <video
              src={playingVideoUrl}
              controls
              autoPlay
              className="w-full rounded-lg"
            />
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <GalleryContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          imageId={contextMenu.imageId}
          approvalStatus={contextMenu.approvalStatus}
          onAction={handleContextMenuAction}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          onDelete={handleDelete}
          projectId={projectId}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}
    </div>
  )
}
