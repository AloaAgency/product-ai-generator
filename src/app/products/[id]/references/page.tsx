'use client'

import { use, useEffect, useState, useRef } from 'react'
import { useAppStore } from '@/lib/store'
import ReferenceLightbox, { type ReferenceLightboxImage } from '@/components/ReferenceLightbox'
import {
  Plus,
  Trash2,
  Upload,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Loader2,
  ImageIcon,
  X,
  Pencil,
} from 'lucide-react'

export default function ReferencesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)

  const {
    referenceSets,
    loadingRefSets,
    referenceImages,
    fetchReferenceSets,
    createReferenceSet,
    updateReferenceSet,
    deleteReferenceSet,
    fetchReferenceImages,
    uploadReferenceImages,
    deleteReferenceImage,
  } = useAppStore()

  const [selectedSetId, setSelectedSetId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editingSetId, setEditingSetId] = useState<string | null>(null)
  const [editingSetName, setEditingSetName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSetNameSave = async (setId: string) => {
    const trimmed = editingSetName.trim()
    const set = referenceSets.find((s) => s.id === setId)
    if (trimmed && trimmed !== set?.name) {
      await updateReferenceSet(id, setId, { name: trimmed })
    }
    setEditingSetId(null)
  }

  useEffect(() => {
    fetchReferenceSets(id)
  }, [id, fetchReferenceSets])

  useEffect(() => {
    if (selectedSetId) {
      fetchReferenceImages(id, selectedSetId)
    }
  }, [id, selectedSetId, fetchReferenceImages])

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const set = await createReferenceSet(id, {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      })
      setNewName('')
      setNewDescription('')
      setShowCreateForm(false)
      setSelectedSetId(set.id)
    } finally {
      setCreating(false)
    }
  }

  const handleActivate = async (setId: string) => {
    await updateReferenceSet(id, setId, { is_active: true })
    await fetchReferenceSets(id)
  }

  const handleDelete = async (setId: string) => {
    if (!confirm('Delete this reference set and all its images?')) return
    await deleteReferenceSet(id, setId)
    if (selectedSetId === setId) setSelectedSetId(null)
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedSetId || !e.target.files?.length) return
    setUploading(true)
    setUploadError(null)
    try {
      await uploadReferenceImages(id, selectedSetId, Array.from(e.target.files))
      await fetchReferenceImages(id, selectedSetId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDeleteImage = async (imgId: string) => {
    if (!selectedSetId) return
    await deleteReferenceImage(id, selectedSetId, imgId)
  }

  const MAX_REFERENCE_IMAGES = 14
  const images = selectedSetId ? referenceImages[selectedSetId] || [] : []
  const atLimit = images.length >= MAX_REFERENCE_IMAGES
  const lightboxImages: ReferenceLightboxImage[] = images.map((img) => ({
    id: img.id,
    public_url: img.public_url,
    file_name: img.file_name,
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Reference Sets</h1>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Set
        </button>
      </div>

      {showCreateForm && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <input
            type="text"
            placeholder="Set name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            autoFocus
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {creating && <Loader2 className="h-3 w-3 animate-spin" />}
              Create
            </button>
            <button
              onClick={() => {
                setShowCreateForm(false)
                setNewName('')
                setNewDescription('')
              }}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loadingRefSets ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        </div>
      ) : referenceSets.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-12 text-center">
          <ImageIcon className="mx-auto h-10 w-10 text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No reference sets yet. Create one to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {referenceSets.map((set) => {
            const isSelected = selectedSetId === set.id
            return (
              <div
                key={set.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden"
              >
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors"
                  onClick={() =>
                    setSelectedSetId(isSelected ? null : set.id)
                  }
                >
                  {isSelected ? (
                    <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-zinc-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {editingSetId === set.id ? (
                        <input
                          key="name-input"
                          value={editingSetName}
                          onChange={(e) => setEditingSetName(e.target.value)}
                          onBlur={() => handleSetNameSave(set.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSetNameSave(set.id)
                            if (e.key === 'Escape') setEditingSetId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-white truncate bg-zinc-800 rounded px-1 outline-none focus:ring-1 focus:ring-blue-500"
                          autoFocus
                        />
                      ) : (
                        <span
                          key="name-label"
                          className="group/name inline-flex items-center gap-1.5 font-medium text-white truncate cursor-pointer hover:text-blue-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingSetId(set.id)
                            setEditingSetName(set.name)
                          }}
                          title="Click to rename"
                        >
                          {set.name}
                          <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/name:opacity-100 transition-opacity text-zinc-500" />
                        </span>
                      )}
                      {set.is_active && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-900/50 px-2 py-0.5 text-xs font-medium text-green-400 border border-green-800">
                          <CheckCircle className="h-3 w-3" />
                          Active
                        </span>
                      )}
                    </div>
                    {set.description && (
                      <p className="text-xs text-zinc-500 truncate mt-0.5">
                        {set.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!set.is_active && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleActivate(set.id)
                        }}
                        className="rounded-md p-1.5 text-zinc-500 hover:text-green-400 hover:bg-zinc-800 transition-colors"
                        title="Set as active"
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(set.id)
                      }}
                      className="rounded-md p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                      title="Delete set"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {isSelected && (
                  <div className="border-t border-zinc-800 p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${atLimit ? 'text-yellow-400' : 'text-zinc-400'}`}>
                        {images.length} / {MAX_REFERENCE_IMAGES} image{images.length !== 1 && 's'}
                      </span>
                      <div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={handleUpload}
                          className="hidden"
                        />
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploading || atLimit}
                          className="flex items-center gap-2 rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                        >
                          {uploading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                          Upload Images
                        </button>
                      </div>
                    </div>

                    {uploadError && (
                      <div className="rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
                        {uploadError}
                      </div>
                    )}

                    {images.length > 0 ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                        {images.map((img) => (
                          <div
                            key={img.id}
                            className="group relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-zinc-800"
                            onClick={() => setLightboxIndex(images.findIndex((i) => i.id === img.id))}
                          >
                            {img.public_url ? (
                              <img
                                src={img.public_url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-zinc-500">
                                <ImageIcon className="h-6 w-6" />
                              </div>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteImage(img.id) }}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="absolute top-1.5 right-1.5 rounded-full bg-black/70 p-1 text-white opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-center text-sm text-zinc-600 py-6">
                        No images in this set. Upload some to get started.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {lightboxIndex !== null && (
        <ReferenceLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
        />
      )}
    </div>
  )
}
