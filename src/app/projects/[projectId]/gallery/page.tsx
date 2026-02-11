'use client'

import { use, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { ProjectHeader } from '@/components/ProjectHeader'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import type { GeneratedImage } from '@/lib/types'
import {
  Filter,
  ImageIcon,
  Loader2,
  Video,
  Play,
  X,
  Package,
} from 'lucide-react'

type StatusFilter = 'all' | 'pending' | 'approved'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
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
  const { currentProject, fetchProject, updateProject } = useAppStore()

  const [productGroups, setProductGroups] = useState<ProductGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const signedUrlsRef = useRef(signedUrlsById)

  useEffect(() => {
    signedUrlsRef.current = signedUrlsById
  }, [signedUrlsById])

  useEffect(() => {
    fetchProject(projectId)
  }, [projectId, fetchProject])

  const fetchProjectGallery = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('approval_status', statusFilter)
      if (mediaFilter !== 'all') params.set('media_type', mediaFilter)
      if (productFilter !== 'all') params.set('product_id', productFilter)

      const res = await fetch(`/api/projects/${projectId}/gallery?${params}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setProductGroups(data.products || [])
    } catch (err) {
      console.error('[ProjectGallery] Fetch error:', err)
      setProductGroups([])
    } finally {
      setLoading(false)
    }
  }, [projectId, statusFilter, mediaFilter, productFilter])

  useEffect(() => {
    fetchProjectGallery()
  }, [fetchProjectGallery])

  // All unique product names for filter dropdown
  const allProducts = useMemo(() => {
    return productGroups.map((g) => ({
      id: g.product_id,
      name: g.product_name,
    }))
  }, [productGroups])

  // Flat list of all non-video images for lightbox navigation
  const allImageOnly = useMemo(() => {
    const result: (GeneratedImage & { _productName: string })[] = []
    for (const group of productGroups) {
      for (const img of group.images) {
        if (img.media_type !== 'video') {
          result.push({ ...img, _productName: group.product_name })
        }
      }
    }
    return result
  }, [productGroups])

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
    }))
  }, [allImageOnly, signedUrlsById])

  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) {
      return cached
    }

    const res = await fetch(`/api/images/${imageId}/signed`)
    if (!res.ok) return null
    const data = (await res.json()) as SignedImageUrls
    const next = { ...signedUrlsRef.current, [imageId]: data }
    signedUrlsRef.current = next
    setSignedUrlsById(next)
    return data
  }, [])

  useModalShortcuts({
    isOpen: !!playingVideoUrl,
    onClose: () => setPlayingVideoUrl(null),
  })

  const handleApprovalChange = async (imageId: string, status: ApprovalStatus) => {
    if (status === 'rejected') {
      await fetch(`/api/images/${imageId}`, { method: 'DELETE' })
    } else {
      await fetch(`/api/images/${imageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_status: status }),
      })
    }
    // Refresh gallery after change
    await fetchProjectGallery()
    // Close lightbox if deleted and no more images
    if (status === 'rejected' && lightboxIndex !== null) {
      const newTotal = allImageOnly.filter((img) => img.id !== imageId).length
      if (newTotal === 0) {
        setLightboxIndex(null)
      } else if (lightboxIndex >= newTotal) {
        setLightboxIndex(newTotal - 1)
      }
    }
  }

  const handleNameSave = async (name: string) => {
    await updateProject(projectId, { name })
  }

  // Prefetch signed URLs around lightbox index
  useEffect(() => {
    if (lightboxIndex === null) return
    const current = allImageOnly[lightboxIndex]
    if (!current) return
    void ensureSignedUrls(current.id)
    const next = allImageOnly[lightboxIndex + 1]
    if (next) void ensureSignedUrls(next.id)
    const prev = allImageOnly[lightboxIndex - 1]
    if (prev) void ensureSignedUrls(prev.id)
  }, [lightboxIndex, allImageOnly, ensureSignedUrls])

  const totalImages = productGroups.reduce((sum, g) => sum + g.images.length, 0)

  const statusBadge = (status: string | null) => {
    switch (status) {
      case 'approved':
        return (
          <span className="absolute top-2 right-2 rounded-full bg-green-600 px-2 py-0.5 text-xs font-medium text-white">
            Approved
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
      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Filter className="h-4 w-4 text-zinc-500" />
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  statusFilter === f.value
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mx-2 h-5 w-px bg-zinc-700" />

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
              <div className="mx-2 h-5 w-px bg-zinc-700" />
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

          <span className="ml-auto rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
            {totalImages} item{totalImages !== 1 ? 's' : ''}
          </span>
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
            Generate images in your products to see them here.
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-6xl space-y-8 p-6">
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
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {group.images.map((img) => {
                  const isVideo = img.media_type === 'video'
                  const globalIndex = allImageOnly.findIndex(
                    (item) => item.id === img.id
                  )
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
                      className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 hover:border-zinc-600 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500"
                    >
                      {isVideo ? (
                        <div className="flex h-full w-full items-center justify-center bg-zinc-800">
                          <Play className="h-10 w-10 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
                        </div>
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={img.thumb_public_url ?? img.public_url ?? undefined}
                          alt={`Variation ${img.variation_number}`}
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                      )}
                      {isVideo && (
                        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-purple-600/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          <Video className="h-3 w-3" /> Video
                        </span>
                      )}
                      {statusBadge(img.approval_status)}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
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

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          promptName={allImageOnly[lightboxIndex]?._productName}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}
    </div>
  )
}
