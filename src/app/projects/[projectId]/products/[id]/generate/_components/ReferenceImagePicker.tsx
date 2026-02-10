'use client'

import { useState, useRef, useEffect } from 'react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { X, Upload, Loader2, Image as ImageIcon } from 'lucide-react'
import type { GeneratedImage } from '@/lib/types'

interface ReferenceImagePickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (imageId: string, thumbUrl: string | null) => void
  productId: string
}

const api = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export function ReferenceImagePicker({ isOpen, onClose, onSelect, productId }: ReferenceImagePickerProps) {
  const [tab, setTab] = useState<'gallery' | 'upload'>('gallery')
  const [galleryImages, setGalleryImages] = useState<GeneratedImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useModalShortcuts({ isOpen, onClose })

  useEffect(() => {
    if (!isOpen) return
    setTab('gallery')
    setLoadingGallery(true)
    api(`/api/products/${productId}/gallery?media_type=image&approval_status=approved`)
      .then((data) => setGalleryImages(data.images ?? data))
      .catch(() => setGalleryImages([]))
      .finally(() => setLoadingGallery(false))
  }, [isOpen, productId])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
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
          <h2 className="text-sm font-semibold text-zinc-200">Select Reference Image</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:text-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
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
              <p className="text-center text-sm text-zinc-500 py-8">No approved images in gallery.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {galleryImages.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => onSelect(img.id, img.thumb_public_url || img.public_url || null)}
                    className="h-24 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 hover:border-blue-500 transition-colors"
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
