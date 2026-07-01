'use client'

import { useState, useRef, useEffect } from 'react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { X, Upload, Loader2, Image as ImageIcon } from 'lucide-react'
import type { GeneratedImage } from '@/lib/types'
import { api, uploadToSignedUrl, cleanupImageRecord } from '@/lib/api-client'

interface ReferenceImagePickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (imageId: string, thumbUrl: string | null) => void
  productId: string
}

export function ReferenceImagePicker({ isOpen, onClose, onSelect, productId }: ReferenceImagePickerProps) {
  const [tab, setTab] = useState<'gallery' | 'upload'>('gallery')
  const [galleryImages, setGalleryImages] = useState<GeneratedImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useModalShortcuts({ isOpen, onClose })

  useEffect(() => {
    if (!isOpen) return
    setTab('gallery')
    setUploadError(null)
    setLoadingGallery(true)
    api(`/api/products/${productId}/gallery?media_type=image&approval_status=approved&limit=200`)
      .then((data) => setGalleryImages(data.images ?? data))
      .catch((err) => {
        setGalleryImages([])
        setUploadError(err instanceof Error ? err.message : 'Failed to load gallery images')
      })
      .finally(() => setLoadingGallery(false))
  }, [isOpen, productId])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const results = await api(`/api/products/${productId}/gallery/upload`, {
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
      const firstResult = Array.isArray(results) ? results[0] : null
      if (!firstResult || firstResult.error || !firstResult.signed_url || !firstResult.image?.id) {
        throw new Error(firstResult?.error || 'Failed to prepare upload')
      }
      try {
        await uploadToSignedUrl(firstResult.signed_url, file, file.type)
      } catch (err) {
        await cleanupImageRecord(firstResult.image.id)
        throw err
      }
      // Fetch a signed download URL so the thumbnail can be displayed
      const signedRes = await fetch(`/api/images/${firstResult.image.id}/signed`)
      const signedData = signedRes.ok ? await signedRes.json() : null
      const thumbUrl = signedData?.thumb_signed_url || signedData?.preview_signed_url || signedData?.signed_url || null
      onSelect(firstResult.image.id, thumbUrl)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl sm:mx-4 rounded-t-xl sm:rounded-xl border border-zinc-700 bg-zinc-900 p-4 sm:p-5 max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-200">Select Reference Image</h2>
          <button
            onClick={onClose}
            className="rounded p-2 text-zinc-400 hover:text-zinc-100 min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4 border-b border-zinc-700 pb-2">
          <button
            onClick={() => setTab('gallery')}
            className={`px-4 py-2.5 text-xs font-medium rounded-t transition-colors min-h-[44px] ${tab === 'gallery' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Gallery
          </button>
          <button
            onClick={() => setTab('upload')}
            className={`px-4 py-2.5 text-xs font-medium rounded-t transition-colors min-h-[44px] ${tab === 'upload' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Upload
          </button>
        </div>

        {tab === 'gallery' ? (
          <div className="overflow-y-auto flex-1 min-h-0">
            {loadingGallery ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
              </div>
            ) : galleryImages.length === 0 ? (
              <p className="text-center text-sm text-zinc-500 py-8">No approved images in gallery.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 pb-2">
                {galleryImages.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => onSelect(img.id, img.thumb_public_url || img.public_url || null)}
                    className="aspect-square overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 hover:border-blue-500 transition-colors min-h-[80px]"
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
            {uploadError && (
              <div className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
                {uploadError}
              </div>
            )}
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
                className="w-full flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 px-8 py-10 text-zinc-400 hover:border-blue-500 hover:text-blue-400 transition-colors"
              >
                <Upload className="h-8 w-8" />
                <span className="text-sm font-medium">Tap to upload an image</span>
                <span className="text-xs text-zinc-500">PNG, JPG, WebP</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
