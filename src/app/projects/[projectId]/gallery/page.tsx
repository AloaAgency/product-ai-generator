'use client'

import { use, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { ProjectHeader } from '@/components/ProjectHeader'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import { GalleryContextMenu, type ContextMenuAction } from '@/components/GalleryContextMenu'
import { VirtualizedSquareGrid } from '@/components/VirtualizedSquareGrid'
import type { GeneratedImage } from '@/lib/types'
import {
  Filter,
  ImageIcon,
  Loader2,
  Video,
  Play,
  X,
  Package,
  Trash2,
} from 'lucide-react'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'request_changes'

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

interface ProductGroup {
  product_id: string
  product_name: string
  images: GeneratedImage[]
}

export default function ProjectGalleryPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = use(params)
  const currentProject = useAppStore((state) => state.currentProject)
  const fetchProject = useAppStore((state) => state.fetchProject)
  const updateProject = useAppStore((state) => state.updateProject)
  const bulkDeleteImages = useAppStore((state) => state.bulkDeleteImages)

  const [productGroups, setProductGroups] = useState<ProductGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [galleryTotal, setGalleryTotal] = useState(0)
  const [currentOffset, setCurrentOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const [rejectedCount, setRejectedCount] = useState(0)
  const [requestChangesCount, setRequestChangesCount] = useState(0)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const signedUrlsRef = useRef(signedUrlsById)
  const signedUrlRequestsRef = useRef<Record<string, Promise<SignedImageUrls | null>>>({})
  const batchSignedUrlRequestsRef = useRef<Record<string, Promise<Record<string, SignedImageUrls>>>>({})
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; imageId: string; approvalStatus: string | null } | null>(null)

  useEffect(() => {
    signedUrlsRef.current = signedUrlsById
  }, [signedUrlsById])

  useEffect(() => {
    fetchProject(projectId)
  }, [projectId, fetchProject])

  const buildParams = useCallback((extraOffset?: number) => {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('approval_status', statusFilter)
    if (mediaFilter !== 'all') params.set('media_type', mediaFilter)
    if (productFilter !== 'all') params.set('product_id', productFilter)
    params.set('limit', '48')
    params.set('offset', String(extraOffset ?? 0))
    return params
  }, [statusFilter, mediaFilter, productFilter])

  const fetchProjectGallery = useCallback(async () => {
    setLoading(true)
    try {
      const params = buildParams(0)
      const res = await fetch(`/api/projects/${projectId}/gallery?${params}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setProductGroups(data.products || [])
      setGalleryTotal(data.total ?? 0)
      setHasMore(data.has_more ?? false)
      setCurrentOffset((data.products || []).reduce((sum: number, g: ProductGroup) => sum + g.images.length, 0))
      if (typeof data.rejected_count === 'number') {
        setRejectedCount(data.rejected_count)
      }
      if (typeof data.request_changes_count === 'number') {
        setRequestChangesCount(data.request_changes_count)
      }
    } catch (err) {
      console.error('[ProjectGallery] Fetch error:', err)
      setProductGroups([])
    } finally {
      setLoading(false)
    }
  }, [projectId, buildParams])

  const fetchMore = useCallback(async () => {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const params = buildParams(currentOffset)
      const res = await fetch(`/api/projects/${projectId}/gallery?${params}`)
      if (!res.ok) throw new Error('Failed to fetch more')
      const data = await res.json()
      const newGroups: ProductGroup[] = data.products || []
      // Merge into existing groups by product_id
      setProductGroups((prev) => {
        const merged = new Map<string, ProductGroup>()
        for (const g of prev) merged.set(g.product_id, { ...g, images: [...g.images] })
        for (const g of newGroups) {
          const existing = merged.get(g.product_id)
          if (existing) {
            const existingIds = new Set(existing.images.map((img) => img.id))
            const unique = g.images.filter((img) => !existingIds.has(img.id))
            existing.images.push(...unique)
          } else {
            merged.set(g.product_id, g)
          }
        }
        return Array.from(merged.values())
      })
      const newImageCount = newGroups.reduce((sum, g) => sum + g.images.length, 0)
      setCurrentOffset((prev) => prev + newImageCount)
      setHasMore(data.has_more ?? false)
    } catch (err) {
      console.error('[ProjectGallery] Fetch more error:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [projectId, buildParams, currentOffset, hasMore, loadingMore])

  useEffect(() => {
    fetchProjectGallery()
  }, [fetchProjectGallery])

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore) {
          fetchMore()
        }
      },
      { rootMargin: '400px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, fetchMore])

  // All unique product names for filter dropdown
  const allProducts = useMemo(() => {
    return productGroups.map((g) => ({
      id: g.product_id,
      name: g.product_name,
    }))
  }, [productGroups])

  // Flat list of all non-video images for lightbox navigation
  const allImageOnly = useMemo(() => {
    const result: (GeneratedImage & { _productName: string; _prompt?: string | null; _productId: string })[] = []
    for (const group of productGroups) {
      for (const img of group.images) {
        if (img.media_type !== 'video') {
          result.push({
            ...img,
            _productName: group.product_name,
            _prompt: (img as GeneratedImage & { prompt?: string | null }).prompt ?? null,
            _productId: group.product_id,
          })
        }
      }
    }
    return result
  }, [productGroups])

  const imageIndexById = useMemo(() => {
    const indexMap = new Map<string, number>()
    allImageOnly.forEach((img, index) => {
      indexMap.set(img.id, index)
    })
    return indexMap
  }, [allImageOnly])

  const lightboxImages: LightboxImage[] = useMemo(() => {
    return allImageOnly.map((img) => ({
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
      prompt: img._prompt,
      productId: img._productId,
    }))
  }, [allImageOnly, signedUrlsById])

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
    if (allImageOnly.length === 0) return

    const warmIds = allImageOnly.slice(0, 6).map((img) => img.id)
    const timeout = window.setTimeout(() => {
      void ensureSignedUrlsBatch(warmIds)
    }, 150)

    return () => window.clearTimeout(timeout)
  }, [allImageOnly, ensureSignedUrlsBatch, lightboxIndex])

  const warmLightboxAssets = useCallback((imageId: string) => {
    const index = imageIndexById.get(imageId)
    if (index === undefined) return

    const warmIndexes = [index, index - 1, index + 1, index + 2]
    const warmIds = warmIndexes
      .map((warmIndex) => allImageOnly[warmIndex]?.id)
      .filter((value): value is string => Boolean(value))
    if (warmIds.length > 0) {
      void ensureSignedUrlsBatch(warmIds)
    }
  }, [allImageOnly, ensureSignedUrlsBatch, imageIndexById])

  useModalShortcuts({
    isOpen: !!playingVideoUrl,
    onClose: () => setPlayingVideoUrl(null),
  })

  const handleApprovalChange = useCallback(async (imageId: string, status: ApprovalStatus, notes?: string) => {
    await fetch(`/api/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_status: status, ...(notes !== undefined ? { notes } : {}) }),
    })
    await fetchProjectGallery()
  }, [fetchProjectGallery])

  const handleDelete = useCallback(async (imageId: string) => {
    await fetch(`/api/images/${imageId}`, { method: 'DELETE' })
    await fetchProjectGallery()
    // Adjust lightbox after deletion
    if (lightboxIndex !== null) {
      const newTotal = allImageOnly.filter((img) => img.id !== imageId).length
      if (newTotal === 0) {
        setLightboxIndex(null)
      } else if (lightboxIndex >= newTotal) {
        setLightboxIndex(newTotal - 1)
      }
    }
  }, [allImageOnly, fetchProjectGallery, lightboxIndex])

  const handleBulkDelete = async () => {
    const rejectedIds = allImageOnly
      .filter((img) => img.approval_status === 'rejected')
      .map((img) => img.id)
    if (rejectedIds.length === 0) return
    if (!window.confirm(`Permanently delete ${rejectedIds.length} rejected image${rejectedIds.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      await bulkDeleteImages(rejectedIds)
      await fetchProjectGallery()
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleContextMenuAction = useCallback(async (action: ContextMenuAction, imageId: string) => {
    const img = allImageOnly.find((i) => i.id === imageId)
    if (!img) return

    switch (action) {
      case 'open': {
        const idx = imageIndexById.get(imageId) ?? -1
        if (idx !== -1) setLightboxIndex(idx)
        break
      }
      case 'approve':
        await handleApprovalChange(imageId, img.approval_status === 'approved' ? null : 'approved')
        break
      case 'reject':
        await handleApprovalChange(imageId, img.approval_status === 'rejected' ? null : 'rejected')
        break
      case 'request_changes':
        await handleApprovalChange(imageId, img.approval_status === 'request_changes' ? null : 'request_changes')
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
  }, [allImageOnly, imageIndexById, handleApprovalChange, ensureSignedUrls, handleDelete])

  const handleNameSave = async (name: string) => {
    await updateProject(projectId, { name })
  }

  // Prefetch signed URLs around lightbox index
  useEffect(() => {
    if (lightboxIndex === null) return
    const warmIndexes = [lightboxIndex, lightboxIndex - 1, lightboxIndex + 1, lightboxIndex - 2, lightboxIndex + 2]
    const warmIds = warmIndexes
      .map((index) => allImageOnly[index]?.id)
      .filter((value): value is string => Boolean(value))
    if (warmIds.length > 0) {
      void ensureSignedUrlsBatch(warmIds)
    }
  }, [allImageOnly, ensureSignedUrlsBatch, lightboxIndex])

  const totalImages = productGroups.reduce((sum, g) => sum + g.images.length, 0)

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
    <div className="min-h-screen">
      <ProjectHeader
        projectId={projectId}
        projectName={currentProject?.name}
        projectDescription={currentProject?.description}
        onNameSave={handleNameSave}
      />

      {/* Filter bar */}
      <div className="border-b border-zinc-800 px-4 sm:px-6 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 sm:gap-4">
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

          {allProducts.length > 1 && (
            <>
              <div className="mx-2 hidden sm:block h-5 w-px bg-zinc-700" />
              <select
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
              >
                <option value="all">All Products</option>
                {allProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="ml-0 sm:ml-auto flex items-center gap-2">
            {statusFilter === 'rejected' && totalImages > 0 && (
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40 transition-colors"
              >
                {bulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete All Rejected
              </button>
            )}
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
              {galleryTotal > totalImages ? `${totalImages} of ${galleryTotal}` : totalImages} item{galleryTotal !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
        </div>
      ) : productGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 text-zinc-500">
          <div className="mb-4 rounded-full bg-zinc-800 p-4">
            <Package className="h-8 w-8" />
          </div>
          <p className="text-lg font-medium">No images found</p>
          <p className="mt-1 text-sm">
            {statusFilter === 'rejected'
              ? 'No rejected images to review.'
              : statusFilter === 'request_changes'
                ? 'No images with requested changes.'
                : 'Generate images in your products to see them here.'}
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-6xl space-y-8 px-4 sm:px-6 py-6">
          {productGroups.map((group) => (
            <div key={group.product_id}>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-lg font-semibold text-zinc-200">
                  {group.product_name}
                </h2>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {group.images.length}
                </span>
              </div>
              <VirtualizedSquareGrid
                items={group.images}
                getItemKey={(img) => img.id}
                renderItem={(img) => {
                  const isVideo = img.media_type === 'video'
                  const isRejected = img.approval_status === 'rejected'
                  const isChanges = img.approval_status === 'request_changes'
                  const globalIndex = imageIndexById.get(img.id) ?? -1
                  return (
                    <button
                      key={img.id}
                      onClick={() => {
                        if (isVideo && img.public_url) {
                          setPlayingVideoUrl(img.public_url)
                        } else if (globalIndex !== -1) {
                          setLightboxIndex(globalIndex)
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
                        isRejected
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
          ))}
        </div>
      )}

      {/* Infinite scroll sentinel */}
      {!loading && hasMore && (
        <div ref={loadMoreRef} className="flex items-center justify-center py-8">
          {loadingMore && <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />}
        </div>
      )}

      {/* Video playback overlay */}
      {playingVideoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setPlayingVideoUrl(null)}
        >
          <div
            className="relative w-full max-w-4xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
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
          promptName={allImageOnly[lightboxIndex]?._productName}
          projectId={projectId}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}
    </div>
  )
}
