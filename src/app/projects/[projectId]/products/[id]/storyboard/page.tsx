'use client'

import { use, useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '@/lib/store'
import type { Storyboard as StoryboardRecord, StoryboardScene } from '@/lib/types'
import {
  Film,
  Plus,
  Trash2,
  Play,
  Pencil,
  X,
  ChevronUp,
  ChevronDown,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Image as ImageIcon,
  Clapperboard,
  Video,
} from 'lucide-react'

type SignedImageUrls = {
  signed_url: string | null
  thumb_signed_url: string | null
  preview_signed_url: string | null
  expires_at: number
}

type Storyboard = StoryboardRecord

const api = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StoryboardPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { id } = use(params)
  const { galleryImages, loadingGallery, fetchGallery } = useAppStore()
  const galleryImageItems = useMemo(
    () => galleryImages.filter((img) => img.media_type !== 'video'),
    [galleryImages]
  )

  // Storyboard state
  const [storyboards, setStoryboards] = useState<Storyboard[]>([])
  const [loadingStoryboards, setLoadingStoryboards] = useState(false)
  const [editing, setEditing] = useState<Storyboard | null>(null)
  const [editorName, setEditorName] = useState('')
  const [editorImageIds, setEditorImageIds] = useState<string[]>([])

  // Scene-based editing
  const [activeBoard, setActiveBoard] = useState<Storyboard | null>(null)
  const [scenes, setScenes] = useState<StoryboardScene[]>([])
  const [loadingScenes, setLoadingScenes] = useState(false)
  const [generatingScene, setGeneratingScene] = useState<string | null>(null)
  const [generatingVideo, setGeneratingVideo] = useState<string | null>(null)
  const [sceneVideos, setSceneVideos] = useState<Record<string, Array<{ id: string; public_url: string | null; created_at: string }>>>({})

  // Presentation state
  const [presenting, setPresenting] = useState<Storyboard | null>(null)
  const [presentIndex, setPresentIndex] = useState(0)
  const [presentScenes, setPresentScenes] = useState<StoryboardScene[]>([])

  // Signed URLs cache
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const signedUrlsRef = useRef(signedUrlsById)
  useEffect(() => { signedUrlsRef.current = signedUrlsById }, [signedUrlsById])

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Load gallery + storyboards
  useEffect(() => { fetchGallery(id) }, [id, fetchGallery])
  useEffect(() => {
    const load = async () => {
      setLoadingStoryboards(true)
      try {
        const data = await api(`/api/products/${id}/storyboards`)
        setStoryboards(data)
      } finally {
        setLoadingStoryboards(false)
      }
    }
    void load()
  }, [id])

  // Signed URL fetcher
  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) return cached
    const res = await fetch(`/api/images/${imageId}/signed`)
    if (!res.ok) return null
    const data = (await res.json()) as SignedImageUrls
    const next = { ...signedUrlsRef.current, [imageId]: data }
    signedUrlsRef.current = next
    setSignedUrlsById(next)
    return data
  }, [])

  // -----------------------------------------------------------------------
  // Scene helpers
  // -----------------------------------------------------------------------

  async function loadScenes(boardId: string) {
    setLoadingScenes(true)
    try {
      const data = await api(`/api/products/${id}/storyboards/${boardId}/scenes`)
      setScenes(data)
    } finally {
      setLoadingScenes(false)
    }
  }

  function openSceneEditor(board: Storyboard) {
    setActiveBoard(board)
    void loadScenes(board.id)
  }

  async function addScene() {
    if (!activeBoard) return
    const scene = await api(`/api/products/${id}/storyboards/${activeBoard.id}/scenes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Scene ${scenes.length + 1}` }),
    })
    setScenes((prev) => [...prev, scene])
  }

  async function updateScene(sceneId: string, updates: Partial<StoryboardScene>) {
    if (!activeBoard) return
    const updated = await api(`/api/products/${id}/storyboards/${activeBoard.id}/scenes/${sceneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  async function deleteScene(sceneId: string) {
    if (!activeBoard) return
    await api(`/api/products/${id}/storyboards/${activeBoard.id}/scenes/${sceneId}`, {
      method: 'DELETE',
    })
    setScenes((prev) => prev.filter((s) => s.id !== sceneId))
  }

  async function moveScene(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= scenes.length) return
    const updated = [...scenes]
    ;[updated[index], updated[target]] = [updated[target], updated[index]]
    // Update scene_order for both
    const a = updated[index]
    const b = updated[target]
    setScenes(updated)
    await Promise.all([
      updateScene(a.id, { scene_order: index } as Partial<StoryboardScene>),
      updateScene(b.id, { scene_order: target } as Partial<StoryboardScene>),
    ])
  }

  async function generateFrame(sceneId: string, frame: 'start' | 'end' | 'both') {
    if (!activeBoard) return
    setGeneratingScene(sceneId)
    try {
      const updated = await api(
        `/api/products/${id}/storyboards/${activeBoard.id}/scenes/${sceneId}/generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame }),
        }
      )
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } finally {
      setGeneratingScene(null)
    }
  }

  async function loadSceneVideos(sceneId: string, boardId: string) {
    try {
      const data = await api(`/api/products/${id}/storyboards/${boardId}/scenes/${sceneId}/videos`)
      setSceneVideos((prev) => ({ ...prev, [sceneId]: data.videos || [] }))
    } catch {
      // ignore
    }
  }

  async function generateVideo(sceneId: string) {
    if (!activeBoard) return
    setGeneratingVideo(sceneId)
    try {
      const scene = scenes.find((s) => s.id === sceneId)
      const model = scene?.generation_model || 'veo3'
      await api(
        `/api/products/${id}/storyboards/${activeBoard.id}/scenes/${sceneId}/generate-video`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        }
      )
      // Reload videos for this scene
      await loadSceneVideos(sceneId, activeBoard.id)
    } finally {
      setGeneratingVideo(null)
    }
  }

  // -----------------------------------------------------------------------
  // Legacy editor actions
  // -----------------------------------------------------------------------

  function openCreate() {
    setEditing({ id: '', product_id: id, name: '', image_ids: [], created_at: '', updated_at: '' })
    setEditorName('')
    setEditorImageIds([])
  }

  function openEdit(board: Storyboard) {
    setEditing(board)
    setEditorName(board.name)
    setEditorImageIds([...board.image_ids])
  }

  function toggleImage(imgId: string) {
    setEditorImageIds((prev) =>
      prev.includes(imgId) ? prev.filter((x) => x !== imgId) : [...prev, imgId],
    )
  }

  function moveImage(index: number, direction: -1 | 1) {
    setEditorImageIds((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function saveEditor() {
    if (!editorName.trim() || editorImageIds.length === 0) return
    const isNew = !editing?.id
    const payload = {
      name: editorName.trim(),
      image_ids: editorImageIds,
    }

    if (isNew) {
      const created = await api(`/api/products/${id}/storyboards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setStoryboards((prev) => [...prev, created])
    } else {
      const updated = await api(`/api/products/${id}/storyboards/${editing!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setStoryboards((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    }
    setEditing(null)
  }

  async function deleteStoryboard(boardId: string) {
    await api(`/api/products/${id}/storyboards/${boardId}`, { method: 'DELETE' })
    setStoryboards((prev) => prev.filter((s) => s.id !== boardId))
    setConfirmDeleteId(null)
  }

  // -----------------------------------------------------------------------
  // Presentation
  // -----------------------------------------------------------------------

  async function openPresentation(board: Storyboard) {
    // Load scenes for presentation
    try {
      const boardScenes: StoryboardScene[] = await api(`/api/products/${id}/storyboards/${board.id}/scenes`)
      if (boardScenes.length > 0) {
        setPresentScenes(boardScenes)
        setPresenting(board)
        setPresentIndex(0)
        return
      }
    } catch { /* fall through to legacy */ }

    // Legacy: use image_ids
    setPresentScenes([])
    setPresenting(board)
    setPresentIndex(0)
  }

  // Build presentation slides from scenes or legacy image_ids
  const presentSlides: { imageId: string; label: string }[] = (() => {
    if (!presenting) return []
    if (presentScenes.length > 0) {
      const slides: { imageId: string; label: string }[] = []
      for (const scene of presentScenes) {
        if (scene.start_frame_image_id) {
          slides.push({ imageId: scene.start_frame_image_id, label: `${scene.title || 'Scene'} - Start` })
        }
        if (scene.paired && scene.end_frame_image_id) {
          slides.push({ imageId: scene.end_frame_image_id, label: `${scene.title || 'Scene'} - End` })
        }
      }
      return slides
    }
    return presenting.image_ids.map((imgId, i) => ({ imageId: imgId, label: `Slide ${i + 1}` }))
  })()

  // Prefetch signed URLs around current presentation index
  useEffect(() => {
    if (!presenting || presentSlides.length === 0) return
    const prefetch = [presentSlides[presentIndex], presentSlides[presentIndex - 1], presentSlides[presentIndex + 1]].filter(Boolean)
    prefetch.forEach((slide) => { if (slide) void ensureSignedUrls(slide.imageId) })
  }, [presenting, presentIndex, ensureSignedUrls, presentSlides])

  // Keyboard navigation in presentation
  useEffect(() => {
    if (!presenting) return
    const len = presentSlides.length
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case ' ':
          e.preventDefault()
          setPresentIndex((i) => Math.min(i + 1, len - 1))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setPresentIndex((i) => Math.max(i - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setPresentIndex(0)
          break
        case 'End':
          e.preventDefault()
          setPresentIndex(len - 1)
          break
        case 'Escape':
          e.preventDefault()
          setPresenting(null)
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [presenting, presentSlides.length])

  // Helper: get best thumbnail URL for an image
  function thumbUrl(imgId: string): string {
    const img = galleryImageItems.find((g) => g.id === imgId)
    const signed = signedUrlsById[imgId]
    return signed?.thumb_signed_url ?? img?.thumb_public_url ?? img?.public_url ?? ''
  }

  function fullUrl(imgId: string): string {
    const img = galleryImageItems.find((g) => g.id === imgId)
    const signed = signedUrlsById[imgId]
    return signed?.signed_url ?? signed?.preview_signed_url ?? img?.public_url ?? ''
  }

  // Ensure signed URLs for scene frame images
  function sceneThumbUrl(imageId: string | null): string {
    if (!imageId) return ''
    void ensureSignedUrls(imageId)
    return thumbUrl(imageId) || signedUrlsById[imageId]?.thumb_signed_url || signedUrlsById[imageId]?.signed_url || ''
  }

  // -----------------------------------------------------------------------
  // Presentation overlay
  // -----------------------------------------------------------------------

  if (presenting) {
    const total = presentSlides.length
    if (total === 0) {
      return (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black text-zinc-400">
          <p>No frames to present.</p>
          <button onClick={() => setPresenting(null)} className="mt-4 rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">Close</button>
        </div>
      )
    }
    const currentSlide = presentSlides[presentIndex]
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-black">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-3 text-zinc-300">
          <span className="text-sm font-medium">{presenting.name}</span>
          <span className="text-sm">{currentSlide.label} ({presentIndex + 1} / {total})</span>
          <button onClick={() => setPresenting(null)} className="rounded p-1 hover:bg-zinc-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main image */}
        <div className="flex flex-1 items-center justify-center overflow-hidden px-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fullUrl(currentSlide.imageId)}
            alt={currentSlide.label}
            className="max-h-full max-w-full object-contain"
          />
        </div>

        {/* Filmstrip */}
        <div className="flex items-center gap-2 overflow-x-auto px-6 py-3">
          {presentSlides.map((slide, i) => (
            <button
              key={`${slide.imageId}-${i}`}
              onClick={() => setPresentIndex(i)}
              className={`flex-shrink-0 h-16 w-16 rounded overflow-hidden border-2 transition-colors ${
                i === presentIndex ? 'border-white' : 'border-transparent opacity-50 hover:opacity-80'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbUrl(slide.imageId)} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Scene editor view
  // -----------------------------------------------------------------------

  if (activeBoard) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100">
        <div className="border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => setActiveBoard(null)} className="rounded p-1 hover:bg-zinc-800">
                <X className="h-5 w-5 text-zinc-400" />
              </button>
              <Clapperboard className="h-5 w-5 text-zinc-400" />
              <h1 className="text-xl font-semibold">{activeBoard.name} — Scenes</h1>
              <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
                {scenes.length}
              </span>
            </div>
            <button
              onClick={addScene}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add Scene
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {loadingScenes ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
            </div>
          ) : scenes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
              <Clapperboard className="mb-4 h-12 w-12" />
              <p className="text-lg font-medium">No scenes yet</p>
              <p className="mt-1 text-sm">Add a scene to get started.</p>
            </div>
          ) : (
            scenes.map((scene, idx) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                index={idx}
                total={scenes.length}
                isGenerating={generatingScene === scene.id}
                isGeneratingVideo={generatingVideo === scene.id}
                videos={sceneVideos[scene.id] || []}
                onUpdate={(updates) => updateScene(scene.id, updates)}
                onDelete={() => deleteScene(scene.id)}
                onMove={(dir) => moveScene(idx, dir)}
                onGenerate={(frame) => generateFrame(scene.id, frame)}
                onGenerateVideo={() => generateVideo(scene.id)}
                onLoadVideos={() => activeBoard && loadSceneVideos(scene.id, activeBoard.id)}
                sceneThumbUrl={sceneThumbUrl}
              />
            ))
          )}
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Manager view
  // -----------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Film className="h-5 w-5 text-zinc-400" />
            <h1 className="text-xl font-semibold">Storyboards</h1>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
              {storyboards.length}
            </span>
          </div>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Storyboard
          </button>
        </div>
      </div>

      {/* Legacy editor modal */}
      {editing && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 pt-16 pb-8">
          <div className="w-full max-w-3xl rounded-xl bg-zinc-900 border border-zinc-700 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                {editing.id ? 'Edit Storyboard' : 'New Storyboard'}
              </h2>
              <button onClick={() => setEditing(null)} className="rounded p-1 hover:bg-zinc-800">
                <X className="h-5 w-5 text-zinc-400" />
              </button>
            </div>

            {/* Name input */}
            <input
              value={editorName}
              onChange={(e) => setEditorName(e.target.value)}
              placeholder="Storyboard name"
              className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
              autoFocus
            />

            {/* Selected images (ordered list) */}
            {editorImageIds.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium text-zinc-400">
                  Sequence ({editorImageIds.length} images)
                </h3>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {editorImageIds.map((imgId, i) => (
                    <div key={imgId} className="flex items-center gap-2 rounded bg-zinc-800 px-2 py-1">
                      <span className="w-6 text-center text-xs font-bold text-zinc-500">{i + 1}</span>
                      <div className="h-8 w-8 flex-shrink-0 overflow-hidden rounded">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={thumbUrl(imgId)} alt="" className="h-full w-full object-cover" />
                      </div>
                      <span className="flex-1 truncate text-xs text-zinc-400">{imgId.slice(0, 12)}...</span>
                      <button onClick={() => moveImage(i, -1)} disabled={i === 0} className="p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30">
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button onClick={() => moveImage(i, 1)} disabled={i === editorImageIds.length - 1} className="p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30">
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button onClick={() => toggleImage(imgId)} className="p-0.5 text-zinc-500 hover:text-red-400">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Image picker grid */}
            <h3 className="mb-2 text-sm font-medium text-zinc-400">Pick images from gallery</h3>
            {loadingGallery ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
              </div>
            ) : galleryImageItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">No gallery images available.</p>
            ) : (
              <div className="grid grid-cols-5 gap-2 max-h-64 overflow-y-auto sm:grid-cols-6 md:grid-cols-8">
                {galleryImageItems.map((img) => {
                  const seqIndex = editorImageIds.indexOf(img.id)
                  const selected = seqIndex !== -1
                  return (
                    <button
                      key={img.id}
                      onClick={() => toggleImage(img.id)}
                      className={`relative aspect-square overflow-hidden rounded border-2 transition-colors ${
                        selected ? 'border-blue-500' : 'border-transparent hover:border-zinc-600'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.thumb_public_url ?? img.public_url ?? ''}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                      {selected && (
                        <span className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                          {seqIndex + 1}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Actions */}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={saveEditor}
                disabled={!editorName.trim() || editorImageIds.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Storyboard list */}
      <div className="p-6">
            {storyboards.length === 0 && !editing ? (
              <div className="flex flex-col items-center justify-center py-32 text-zinc-500">
                <Film className="mb-4 h-16 w-16" />
                <p className="text-lg font-medium">
                  {loadingStoryboards ? 'Loading storyboards...' : 'No storyboards yet'}
                </p>
                <p className="mt-1 text-sm">Create one to sequence your gallery images.</p>
              </div>
            ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {storyboards.map((board) => (
              <div
                key={board.id}
                className="rounded-xl border border-zinc-800 bg-zinc-800/50 p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold truncate">{board.name}</h3>
                  <span className="text-xs text-zinc-500">{board.image_ids.length} images</span>
                </div>

                {/* Thumbnail strip */}
                <div className="flex gap-1 mb-3 overflow-hidden">
                  {board.image_ids.slice(0, 6).map((imgId) => (
                    <div key={imgId} className="h-12 w-12 flex-shrink-0 overflow-hidden rounded">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbUrl(imgId)} alt="" className="h-full w-full object-cover" />
                    </div>
                  ))}
                  {board.image_ids.length > 6 && (
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded bg-zinc-700 text-xs text-zinc-400">
                      +{board.image_ids.length - 6}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => openPresentation(board)}
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 transition-colors"
                  >
                    <Play className="h-3.5 w-3.5" /> Present
                  </button>
                  <button
                    onClick={() => openSceneEditor(board)}
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 transition-colors"
                  >
                    <Clapperboard className="h-3.5 w-3.5" /> Scenes
                  </button>
                  <button
                    onClick={() => openEdit(board)}
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  {confirmDeleteId === board.id ? (
                    <div className="flex items-center gap-1 ml-auto">
                      <button
                        onClick={() => deleteStoryboard(board.id)}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500 transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(board.id)}
                      className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-700 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scene Card component
// ---------------------------------------------------------------------------

function SceneCard({
  scene,
  index,
  total,
  isGenerating,
  isGeneratingVideo,
  videos,
  onUpdate,
  onDelete,
  onMove,
  onGenerate,
  onGenerateVideo,
  onLoadVideos,
  sceneThumbUrl,
}: {
  scene: StoryboardScene
  index: number
  total: number
  isGenerating: boolean
  isGeneratingVideo: boolean
  videos: Array<{ id: string; public_url: string | null; created_at: string }>
  onUpdate: (updates: Partial<StoryboardScene>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
  onGenerate: (frame: 'start' | 'end' | 'both') => void
  onGenerateVideo: () => void
  onLoadVideos: () => void
  sceneThumbUrl: (id: string | null) => string
}) {
  const [localTitle, setLocalTitle] = useState(scene.title || '')
  const [localPrompt, setLocalPrompt] = useState(scene.prompt_text || '')
  const [localEndPrompt, setLocalEndPrompt] = useState(scene.end_frame_prompt || '')
  const [localMotionPrompt, setLocalMotionPrompt] = useState(scene.motion_prompt || '')
  const [localModel, setLocalModel] = useState(scene.generation_model || 'veo3')
  const [showGenMenu, setShowGenMenu] = useState(false)
  const [showVideos, setShowVideos] = useState(false)
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)

  // Sync local state when scene updates from server
  useEffect(() => {
    setLocalTitle(scene.title || '')
    setLocalPrompt(scene.prompt_text || '')
    setLocalEndPrompt(scene.end_frame_prompt || '')
    setLocalMotionPrompt(scene.motion_prompt || '')
    setLocalModel(scene.generation_model || 'veo3')
  }, [scene.title, scene.prompt_text, scene.end_frame_prompt, scene.motion_prompt, scene.generation_model])

  const saveField = (field: string, value: string | boolean) => {
    onUpdate({ [field]: value } as Partial<StoryboardScene>)
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-800/50 p-4">
      {/* Header row */}
      <div className="flex items-center gap-3 mb-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-xs font-bold text-zinc-300">
          {index + 1}
        </span>
        <input
          value={localTitle}
          onChange={(e) => setLocalTitle(e.target.value)}
          onBlur={() => { if (localTitle !== (scene.title || '')) saveField('title', localTitle) }}
          placeholder="Scene title"
          className="flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-zinc-100 outline-none hover:border-zinc-700 focus:border-blue-500 focus:bg-zinc-800"
        />

        {/* Paired toggle */}
        <button
          onClick={() => saveField('paired', !scene.paired)}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
          title={scene.paired ? 'Paired mode (start + end frames)' : 'Single frame mode'}
        >
          {scene.paired ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
          {scene.paired ? 'Paired' : 'Single'}
        </button>

        {/* Reorder */}
        <button onClick={() => onMove(-1)} disabled={index === 0} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30">
          <ChevronUp className="h-4 w-4" />
        </button>
        <button onClick={() => onMove(1)} disabled={index === total - 1} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30">
          <ChevronDown className="h-4 w-4" />
        </button>

        {/* Delete */}
        <button onClick={onDelete} className="p-1 text-zinc-500 hover:text-red-400">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Prompt text area */}
      <div className="space-y-2 mb-3">
        <textarea
          value={localPrompt}
          onChange={(e) => setLocalPrompt(e.target.value)}
          onBlur={() => { if (localPrompt !== (scene.prompt_text || '')) saveField('prompt_text', localPrompt) }}
          placeholder={scene.paired ? 'Start frame prompt...' : 'Scene prompt...'}
          rows={3}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 resize-none"
        />
        {scene.paired && (
          <textarea
            value={localEndPrompt}
            onChange={(e) => setLocalEndPrompt(e.target.value)}
            onBlur={() => { if (localEndPrompt !== (scene.end_frame_prompt || '')) saveField('end_frame_prompt', localEndPrompt) }}
            placeholder="End frame prompt..."
            rows={3}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 resize-none"
          />
        )}
      </div>

      {/* Frame thumbnails */}
      <div className="flex gap-3 mb-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
          <div className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center">
            {scene.start_frame_image_id ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sceneThumbUrl(scene.start_frame_image_id)} alt="Start frame" className="h-full w-full object-cover" />
            ) : (
              <ImageIcon className="h-6 w-6 text-zinc-600" />
            )}
          </div>
        </div>
        {scene.paired && (
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
            <div className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center">
              {scene.end_frame_image_id ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sceneThumbUrl(scene.end_frame_image_id)} alt="End frame" className="h-full w-full object-cover" />
              ) : (
                <ImageIcon className="h-6 w-6 text-zinc-600" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Motion prompt + Video generation */}
      <div className="space-y-2 mb-3">
        <label className="text-xs font-medium text-zinc-400">Motion Prompt (Video)</label>
        <textarea
          value={localMotionPrompt}
          onChange={(e) => setLocalMotionPrompt(e.target.value)}
          onBlur={() => { if (localMotionPrompt !== (scene.motion_prompt || '')) saveField('motion_prompt', localMotionPrompt) }}
          placeholder="Describe the motion/video transition..."
          rows={2}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-purple-500 resize-none"
        />
        <div className="flex items-center gap-2">
          <select
            value={localModel}
            onChange={(e) => {
              setLocalModel(e.target.value)
              saveField('generation_model', e.target.value)
            }}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
          >
            <option value="veo3">Veo 3</option>
            <option value="ltx">LTX Video</option>
          </select>
          {isGeneratingVideo ? (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating video...
            </div>
          ) : (
            <button
              onClick={onGenerateVideo}
              disabled={!localMotionPrompt.trim() || !scene.start_frame_image_id}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Video className="h-3.5 w-3.5" />
              Generate Video
            </button>
          )}
          <button
            onClick={() => {
              setShowVideos(!showVideos)
              if (!showVideos) onLoadVideos()
            }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 transition-colors"
          >
            <Film className="h-3.5 w-3.5" />
            Videos {videos.length > 0 && `(${videos.length})`}
          </button>
        </div>
      </div>

      {/* Video history */}
      {showVideos && (
        <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
          <h4 className="mb-2 text-xs font-medium text-zinc-400">Video History</h4>
          {videos.length === 0 ? (
            <p className="text-xs text-zinc-500">No videos generated yet.</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto">
              {videos.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setPlayingVideoUrl(v.public_url)}
                  className="relative flex-shrink-0 h-20 w-32 overflow-hidden rounded-lg border border-zinc-600 bg-zinc-700 hover:border-zinc-400 transition-colors"
                >
                  <div className="flex h-full w-full items-center justify-center">
                    <Play className="h-6 w-6 text-zinc-300" />
                  </div>
                  <span className="absolute bottom-0.5 right-1 text-[9px] text-zinc-400">
                    {new Date(v.created_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Video playback overlay */}
      {playingVideoUrl && (
        <div className="mb-3 rounded-lg border border-zinc-700 bg-black p-2">
          <div className="flex justify-end mb-1">
            <button onClick={() => setPlayingVideoUrl(null)} className="p-0.5 text-zinc-400 hover:text-zinc-200">
              <X className="h-4 w-4" />
            </button>
          </div>
          <video
            src={playingVideoUrl}
            controls
            autoPlay
            className="w-full rounded"
          />
        </div>
      )}

      {/* Generate button */}
      <div className="relative">
        {isGenerating ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating...
          </div>
        ) : (
          <div className="flex gap-2">
            {scene.paired ? (
              <>
                <button
                  onClick={() => onGenerate('start')}
                  disabled={!localPrompt.trim()}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Generate Start
                </button>
                <button
                  onClick={() => onGenerate('end')}
                  disabled={!localEndPrompt.trim() && !localPrompt.trim()}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Generate End
                </button>
                <button
                  onClick={() => onGenerate('both')}
                  disabled={!localPrompt.trim()}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Generate Both
                </button>
              </>
            ) : (
              <button
                onClick={() => onGenerate('start')}
                disabled={!localPrompt.trim()}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Generate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
