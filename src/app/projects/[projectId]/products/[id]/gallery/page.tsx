'use client'

import { use, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import type { PromptTemplate } from '@/lib/types'
import {
  ArrowLeft,
  Filter,
  Download,
  ImageIcon,
  Loader2,
  Layers,
  Video,
  Play,
  X,
  Upload,
} from 'lucide-react'
import Link from 'next/link'

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

export default function GalleryPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id } = use(params)

  const {
    galleryImages,
    loadingGallery,
    fetchGallery,
    updateImageApproval,
    deleteImage,
    fetchGenerationJobs,
  } = useAppStore()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all')
  const [jobFilter, setJobFilter] = useState<string>('all')
  const [groupByScene, setGroupByScene] = useState(false)
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const signedUrlsRef = useRef(signedUrlsById)

  const [uploadingGallery, setUploadingGallery] = useState(false)
  const galleryFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    signedUrlsRef.current = signedUrlsById
  }, [signedUrlsById])

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
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (!result.signed_url) continue
        const file = fileArray[i]
        await fetch(result.signed_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
      }
      // Refresh gallery
      await fetchGallery(id)
    } catch (err) {
      console.error('[GalleryUpload] Error:', err)
    } finally {
      setUploadingGallery(false)
      if (galleryFileInputRef.current) galleryFileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    fetchGallery(id)
    fetchGenerationJobs(id)
    fetch(`/api/products/${id}/prompts`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setPromptTemplates(data) })
      .catch(() => {})
  }, [id, fetchGallery, fetchGenerationJobs])

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
    return imageOnly.map((img) => ({
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
  }, [imageOnly, signedUrlsById])

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
    } else {
      await updateImageApproval(imageId, status)
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
        await fetchGallery(id)
      } else if (prevHadActive && !hasActive) {
        await fetchGallery(id)
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
  }, [id, fetchGallery, fetchGenerationJobs])

  useEffect(() => {
    if (lightboxIndex === null) return
    const current = imageOnly[lightboxIndex]
    if (!current) return
    void ensureSignedUrls(current.id)

    const next = imageOnly[lightboxIndex + 1]
    if (next) void ensureSignedUrls(next.id)

    const prev = imageOnly[lightboxIndex - 1]
    if (prev) void ensureSignedUrls(prev.id)
  }, [lightboxIndex, imageOnly, ensureSignedUrls])

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
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Link
              href={`/projects/${projectId}/products/${id}`}
              className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-xl font-semibold">Image Gallery</h1>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
              {filteredImages.length} image{filteredImages.length !== 1 ? 's' : ''}
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
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {f.label}
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
            {galleryImages.length === 0
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
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {group.images.map((img) => {
                    const globalIndex = imageOnly.findIndex((item) => item.id === img.id)
                    return (
                      <button
                        key={img.id}
                        onClick={() => {
                          if (globalIndex !== -1) setLightboxIndex(globalIndex)
                        }}
                        className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 hover:border-zinc-600 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.thumb_public_url ?? img.public_url ?? undefined}
                          alt={`Variation ${img.variation_number}`}
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                        {statusBadge(img.approval_status)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 px-4 sm:px-6 py-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {filteredImages.map((img, index) => {
              const isVideo = (img as unknown as Record<string, unknown>).media_type === 'video'
              const imageIndex = imageOnly.findIndex((item) => item.id === img.id)
              return (
                <button
                  key={img.id}
                  onClick={() => {
                    if (isVideo && img.public_url) {
                      setPlayingVideoUrl(img.public_url)
                    } else {
                      if (imageIndex !== -1) setLightboxIndex(imageIndex)
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
        )
      }

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

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}
    </div>
  )
}
