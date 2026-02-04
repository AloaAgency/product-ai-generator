'use client'

import { use, useEffect, useState, useCallback, useRef } from 'react'
import type { StoryboardScene } from '@/lib/types'
import type { GeneratedImage } from '@/lib/types'
import {
  Clapperboard,
  Loader2,
  Play,
  Film,
  Video,
  X,
  Image as ImageIcon,
  Plus,
  Trash2,
  Pencil,
  Check,
  ToggleLeft,
  ToggleRight,
  Upload,
} from 'lucide-react'

type SignedImageUrls = {
  signed_url: string | null
  thumb_signed_url: string | null
  preview_signed_url: string | null
  expires_at: number
}

const VEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const
const VEO_ASPECT_RATIOS = ['16:9', '9:16'] as const
const LTX_RESOLUTIONS = ['1920x1080', '2560x1440', '3840x2160'] as const
const DEFAULT_VEO = { resolution: '1080p', aspectRatio: '16:9', duration: 8, generateAudio: true }
const DEFAULT_LTX = { resolution: '1920x1080', duration: 8, fps: 25, generateAudio: true }
const isLtxModel = (model: string | null | undefined) => {
  if (!model) return false
  return model.toLowerCase().startsWith('ltx')
}
const supportsEndFrame = (model: string | null | undefined) => !isLtxModel(model)

const api = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export default function ScenesPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { id } = use(params)

  const [scenes, setScenes] = useState<StoryboardScene[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingVideo, setGeneratingVideo] = useState<string | null>(null)
  const [sceneVideos, setSceneVideos] = useState<Record<string, Array<{ id: string; public_url: string | null; created_at: string }>>>({})
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [expandedScene, setExpandedScene] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPrompt, setNewPrompt] = useState('')
  const [newEndPrompt, setNewEndPrompt] = useState('')
  const [newMotionPrompt, setNewMotionPrompt] = useState('')
  const [newModel, setNewModel] = useState('veo3')
  const [newStartFrameId, setNewStartFrameId] = useState<string | null>(null)
  const [newEndFrameId, setNewEndFrameId] = useState<string | null>(null)
  const [newResolution, setNewResolution] = useState(DEFAULT_VEO.resolution)
  const [newAspectRatio, setNewAspectRatio] = useState(DEFAULT_VEO.aspectRatio)
  const [newDuration, setNewDuration] = useState(DEFAULT_VEO.duration)
  const [newFps, setNewFps] = useState(DEFAULT_LTX.fps)
  const [newGenerateAudio, setNewGenerateAudio] = useState(DEFAULT_VEO.generateAudio)
  const [creating, setCreating] = useState(false)

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [editEndPrompt, setEditEndPrompt] = useState('')
  const [editMotionPrompt, setEditMotionPrompt] = useState('')
  const [editModel, setEditModel] = useState('veo3')
  const [editResolution, setEditResolution] = useState(DEFAULT_VEO.resolution)
  const [editAspectRatio, setEditAspectRatio] = useState(DEFAULT_VEO.aspectRatio)
  const [editDuration, setEditDuration] = useState(DEFAULT_VEO.duration)
  const [editFps, setEditFps] = useState(DEFAULT_LTX.fps)
  const [editGenerateAudio, setEditGenerateAudio] = useState(DEFAULT_VEO.generateAudio)
  const [saving, setSaving] = useState(false)

  // Delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Frame picker modal
  const [framePicker, setFramePicker] = useState<{
    sceneId?: string
    slot: 'start' | 'end'
    mode: 'create' | 'edit'
  } | null>(null)
  const [pickerTab, setPickerTab] = useState<'gallery' | 'upload'>('gallery')
  const [galleryImages, setGalleryImages] = useState<GeneratedImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function openFramePicker(sceneId: string | null, slot: 'start' | 'end', mode: 'create' | 'edit') {
    setFramePicker({ sceneId: sceneId || undefined, slot, mode })
    setPickerTab('gallery')
    setLoadingGallery(true)
    try {
      const data = await api(`/api/products/${id}/gallery?media_type=image&approval_status=approved`)
      setGalleryImages(data.images ?? data)
    } catch {
      setGalleryImages([])
    } finally {
      setLoadingGallery(false)
    }
  }

  async function selectGalleryImage(imageId: string) {
    if (!framePicker) return
    if (framePicker.mode === 'create') {
      if (framePicker.slot === 'start') {
        setNewStartFrameId(imageId)
      } else {
        setNewEndFrameId(imageId)
      }
      setFramePicker(null)
      return
    }
    if (!framePicker.sceneId) return
    const field = framePicker.slot === 'start' ? 'start_frame_image_id' : 'end_frame_image_id'
    const payload: Record<string, unknown> = { [field]: imageId }
    if (framePicker.slot === 'end') payload.paired = true
    const updated = await api(`/api/products/${id}/scenes/${framePicker.sceneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    setFramePicker(null)
  }

  async function handleFrameUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !framePicker) return
    setUploading(true)
    try {
      if (framePicker.mode === 'create') {
        const results = await api(`/api/products/${id}/gallery/upload`, {
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
        if (framePicker.slot === 'start') {
          setNewStartFrameId(firstResult.image.id)
        } else {
          setNewEndFrameId(firstResult.image.id)
        }
        setFramePicker(null)
        return
      }
      if (!framePicker.sceneId) return
      const { signed_url, image } = await api(`/api/products/${id}/scenes/${framePicker.sceneId}/upload-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot: framePicker.slot,
          file_name: file.name,
          mime_type: file.type,
          file_size: file.size,
        }),
      })
      await fetch(signed_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      const field = framePicker.slot === 'start' ? 'start_frame_image_id' : 'end_frame_image_id'
      setScenes((prev) => prev.map((s) =>
        s.id === framePicker.sceneId ? { ...s, [field]: image.id } : s
      ))
      setFramePicker(null)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function clearSceneFrame(sceneId: string, slot: 'start' | 'end') {
    const field = slot === 'start' ? 'start_frame_image_id' : 'end_frame_image_id'
    const scene = scenes.find((s) => s.id === sceneId)
    const updates: Record<string, unknown> = { [field]: null }
    if (slot === 'end' && !scene?.end_frame_prompt) updates.paired = false
    const updated = await api(`/api/products/${id}/scenes/${sceneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  // Signed URLs
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, SignedImageUrls>>({})
  const signedUrlsRef = useRef(signedUrlsById)
  useEffect(() => { signedUrlsRef.current = signedUrlsById }, [signedUrlsById])

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

  function sceneThumbUrl(imageId: string | null): string | null {
    if (!imageId) return null
    void ensureSignedUrls(imageId)
    return signedUrlsById[imageId]?.thumb_signed_url || signedUrlsById[imageId]?.signed_url || null
  }

  function renderThumb(imageId: string | null, alt: string) {
    const url = sceneThumbUrl(imageId)
    if (!url) return <ImageIcon className="h-6 w-6 text-zinc-600" />
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt} className="h-full w-full object-cover" />
  }

  // Load all scenes for this product
  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const data = await api(`/api/products/${id}/scenes`)
        setScenes(data)
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [id])

  // Load video counts for all scenes after scenes load
  useEffect(() => {
    if (scenes.length === 0) return
    scenes.forEach((scene) => {
      if (!sceneVideos[scene.id]) {
        loadSceneVideos(scene.id)
      }
    })
  }, [scenes])

  async function loadSceneVideos(sceneId: string) {
    try {
      const data = await api(`/api/products/${id}/scenes/${sceneId}/videos`)
      setSceneVideos((prev) => ({ ...prev, [sceneId]: data.videos || [] }))
    } catch { /* ignore */ }
  }

  function handleNewModelChange(value: string) {
    setNewModel(value)
    if (isLtxModel(value)) {
      setNewResolution(DEFAULT_LTX.resolution)
      setNewDuration(DEFAULT_LTX.duration)
      setNewFps(DEFAULT_LTX.fps)
      setNewGenerateAudio(DEFAULT_LTX.generateAudio)
    } else {
      setNewResolution(DEFAULT_VEO.resolution)
      setNewAspectRatio(DEFAULT_VEO.aspectRatio)
      setNewDuration(DEFAULT_VEO.duration)
      setNewGenerateAudio(DEFAULT_VEO.generateAudio)
    }
  }

  function handleEditModelChange(value: string) {
    setEditModel(value)
    if (isLtxModel(value)) {
      setEditResolution(DEFAULT_LTX.resolution)
      setEditDuration(DEFAULT_LTX.duration)
      setEditFps(DEFAULT_LTX.fps)
      setEditGenerateAudio(DEFAULT_LTX.generateAudio)
    } else {
      setEditResolution(DEFAULT_VEO.resolution)
      setEditAspectRatio(DEFAULT_VEO.aspectRatio)
      setEditDuration(DEFAULT_VEO.duration)
      setEditGenerateAudio(DEFAULT_VEO.generateAudio)
    }
  }

  async function handleCreate() {
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const allowEndFrame = supportsEndFrame(newModel)
      const endPrompt = allowEndFrame ? newEndPrompt.trim() || null : null
      const endFrameId = allowEndFrame ? newEndFrameId : null
      const paired = allowEndFrame && (!!endFrameId || !!endPrompt)
      const durationValue = Number.isFinite(newDuration) && newDuration > 0 ? newDuration : null
      const fpsValue = isLtxModel(newModel) && Number.isFinite(newFps) && newFps > 0 ? newFps : null
      const audioValue = newGenerateAudio
      const scene = await api(`/api/products/${id}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          prompt_text: newPrompt.trim() || null,
          end_frame_prompt: endPrompt,
          motion_prompt: newMotionPrompt.trim() || null,
          generation_model: newModel,
          paired,
          start_frame_image_id: newStartFrameId || null,
          end_frame_image_id: endFrameId || null,
          video_resolution: newResolution || null,
          video_aspect_ratio: allowEndFrame ? newAspectRatio || null : null,
          video_duration_seconds: durationValue,
          video_fps: fpsValue,
          video_generate_audio: audioValue,
        }),
      })
      setScenes((prev) => [scene, ...prev])
      setNewTitle('')
      setNewPrompt('')
      setNewEndPrompt('')
      setNewMotionPrompt('')
      setNewModel('veo3')
      setNewStartFrameId(null)
      setNewEndFrameId(null)
      setNewResolution(DEFAULT_VEO.resolution)
      setNewAspectRatio(DEFAULT_VEO.aspectRatio)
      setNewDuration(DEFAULT_VEO.duration)
      setNewFps(DEFAULT_LTX.fps)
      setNewGenerateAudio(DEFAULT_VEO.generateAudio)
      setShowCreate(false)
    } finally {
      setCreating(false)
    }
  }

  function startEdit(scene: StoryboardScene) {
    const model = scene.generation_model || 'veo3'
    setEditingId(scene.id)
    setEditTitle(scene.title || '')
    setEditPrompt(scene.prompt_text || '')
    setEditEndPrompt(scene.end_frame_prompt || '')
    setEditMotionPrompt(scene.motion_prompt || '')
    setEditModel(model)
    setEditResolution(scene.video_resolution || (isLtxModel(model) ? DEFAULT_LTX.resolution : DEFAULT_VEO.resolution))
    setEditAspectRatio(scene.video_aspect_ratio || DEFAULT_VEO.aspectRatio)
    setEditDuration(scene.video_duration_seconds || (isLtxModel(model) ? DEFAULT_LTX.duration : DEFAULT_VEO.duration))
    setEditFps(scene.video_fps || DEFAULT_LTX.fps)
    setEditGenerateAudio(
      scene.video_generate_audio
      ?? (isLtxModel(model) ? DEFAULT_LTX.generateAudio : DEFAULT_VEO.generateAudio)
    )
  }

  async function handleSave() {
    if (!editingId) return
    setSaving(true)
    try {
      const currentScene = scenes.find((s) => s.id === editingId)
      const endPrompt = editEndPrompt.trim() || null
      const endFrameId = currentScene?.end_frame_image_id || null
      const paired = !!endPrompt || !!endFrameId
      const durationValue = Number.isFinite(editDuration) && editDuration > 0 ? editDuration : null
      const fpsValue = isLtxModel(editModel) && Number.isFinite(editFps) && editFps > 0 ? editFps : null
      const audioValue = editGenerateAudio
      const updated = await api(`/api/products/${id}/scenes/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          prompt_text: editPrompt.trim() || null,
          end_frame_prompt: endPrompt,
          motion_prompt: editMotionPrompt.trim() || null,
          generation_model: editModel,
          paired,
          video_resolution: editResolution || null,
          video_aspect_ratio: editAspectRatio || null,
          video_duration_seconds: durationValue,
          video_fps: fpsValue,
          video_generate_audio: audioValue,
        }),
      })
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(sceneId: string) {
    await api(`/api/products/${id}/scenes/${sceneId}`, { method: 'DELETE' })
    setScenes((prev) => prev.filter((s) => s.id !== sceneId))
    setConfirmDeleteId(null)
  }

  async function generateVideo(sceneId: string) {
    setGeneratingVideo(sceneId)
    try {
      const scene = scenes.find((s) => s.id === sceneId)
      const model = scene?.generation_model || 'veo3'
      await api(`/api/products/${id}/scenes/${sceneId}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      await loadSceneVideos(sceneId)
    } finally {
      setGeneratingVideo(null)
    }
  }

  const uploadDisabled = !framePicker || (framePicker.mode !== 'create' && !framePicker.sceneId)

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Clapperboard className="h-5 w-5 text-zinc-400" />
            <h1 className="text-xl font-semibold">Scenes</h1>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-sm text-zinc-400">
              {scenes.length}
            </span>
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Scene
          </button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Create form */}
        {showCreate && (
          <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-300">Create Scene</h2>
              <span className="text-xs text-zinc-500">Key frames, prompts, and video settings</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.1fr_1.4fr]">
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Scene title"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Key frames</span>
                    {!supportsEndFrame(newModel) && (
                      <span className="text-[10px] text-zinc-500">LTX uses the start frame only</span>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
                      <button
                        onClick={() => openFramePicker(null, 'start', 'create')}
                        className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                        title="Select start frame"
                      >
                        {renderThumb(newStartFrameId, 'Start')}
                      </button>
                      {newStartFrameId && (
                        <button
                          onClick={() => setNewStartFrameId(null)}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {supportsEndFrame(newModel) ? (
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                        <button
                          onClick={() => openFramePicker(null, 'end', 'create')}
                          className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                          title="Select end frame"
                        >
                          {renderThumb(newEndFrameId, 'End')}
                        </button>
                        {newEndFrameId && (
                          <button
                            onClick={() => setNewEndFrameId(null)}
                            className="text-[10px] text-zinc-500 hover:text-zinc-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1 opacity-50">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                        <div className="h-20 w-20 rounded-lg border border-dashed border-zinc-700 bg-zinc-800 flex items-center justify-center">
                          <ImageIcon className="h-6 w-6 text-zinc-600" />
                        </div>
                        <span className="text-[10px] text-zinc-600">Veo only</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <textarea
                  rows={3}
                  placeholder="Frame prompt (still image description)..."
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                />
                {supportsEndFrame(newModel) && (
                  <textarea
                    rows={2}
                    placeholder="End frame prompt (optional)..."
                    value={newEndPrompt}
                    onChange={(e) => setNewEndPrompt(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                  />
                )}
                <textarea
                  rows={2}
                  placeholder="Motion prompt (video/motion description)..."
                  value={newMotionPrompt}
                  onChange={(e) => setNewMotionPrompt(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-zinc-500">Model</span>
                    <select
                      value={newModel}
                      onChange={(e) => handleNewModelChange(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                    >
                      <option value="veo3">Veo 3</option>
                      <option value="ltx">LTX-2</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-zinc-500">Resolution</span>
                    <select
                      value={newResolution}
                      onChange={(e) => setNewResolution(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                    >
                      {(isLtxModel(newModel) ? LTX_RESOLUTIONS : VEO_RESOLUTIONS).map((res) => (
                        <option key={res} value={res}>{res}</option>
                      ))}
                    </select>
                  </div>
                  {supportsEndFrame(newModel) && (
                    <div className="space-y-1">
                      <span className="text-[11px] uppercase tracking-wide text-zinc-500">Aspect Ratio</span>
                      <select
                        value={newAspectRatio}
                        onChange={(e) => setNewAspectRatio(e.target.value)}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                      >
                        {VEO_ASPECT_RATIOS.map((ratio) => (
                          <option key={ratio} value={ratio}>{ratio}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-zinc-500">Duration (s)</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={newDuration}
                      onChange={(e) => setNewDuration(Number(e.target.value))}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                    />
                  </div>
                  {isLtxModel(newModel) && (
                    <div className="space-y-1">
                      <span className="text-[11px] uppercase tracking-wide text-zinc-500">FPS</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={newFps}
                        onChange={(e) => setNewFps(Number(e.target.value))}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                      />
                    </div>
                  )}
                  <button
                    onClick={() => setNewGenerateAudio(!newGenerateAudio)}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
                  >
                    {newGenerateAudio ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
                    {newGenerateAudio ? 'Audio On' : 'Audio Off'}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={creating || !newTitle.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Create
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Scene list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
          </div>
        ) : scenes.length === 0 && !showCreate ? (
          <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
            <Clapperboard className="mb-4 h-12 w-12" />
            <p className="text-lg font-medium">No scenes yet</p>
            <p className="mt-1 text-sm">Create a scene to get started.</p>
          </div>
        ) : (
          scenes.map((scene) => {
            const videos = sceneVideos[scene.id] || []
            const isExpanded = expandedScene === scene.id
            const isGenVideo = generatingVideo === scene.id
            const hasFrames = !!scene.start_frame_image_id
            const hasMotion = !!scene.motion_prompt
            const isEditing = editingId === scene.id

            return (
              <div key={scene.id} className="rounded-xl border border-zinc-800 bg-zinc-800/50 p-4">
                {isEditing ? (
                  /* Edit mode */
                  <div className="space-y-4">
                    <div className="grid gap-4 lg:grid-cols-[1.1fr_1.4fr]">
                      <div className="space-y-3">
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                        />
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Key frames</span>
                            {!supportsEndFrame(editModel) && (
                              <span className="text-[10px] text-zinc-500">LTX uses the start frame only</span>
                            )}
                          </div>
                          <div className="flex gap-3">
                            <div className="flex flex-col items-center gap-1">
                              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
                              <button
                                onClick={() => openFramePicker(scene.id, 'start', 'edit')}
                                className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                                title="Select start frame"
                              >
                                {renderThumb(scene.start_frame_image_id, 'Start')}
                              </button>
                              {scene.start_frame_image_id && (
                                <button
                                  onClick={() => clearSceneFrame(scene.id, 'start')}
                                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                            {supportsEndFrame(editModel) ? (
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                                <button
                                  onClick={() => openFramePicker(scene.id, 'end', 'edit')}
                                  className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                                  title="Select end frame"
                                >
                                  {renderThumb(scene.end_frame_image_id, 'End')}
                                </button>
                                {scene.end_frame_image_id && (
                                  <button
                                    onClick={() => clearSceneFrame(scene.id, 'end')}
                                    className="text-[10px] text-zinc-500 hover:text-zinc-300"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            ) : (
                              <div className="flex flex-col items-center gap-1 opacity-50">
                                <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                                <div className="h-20 w-20 rounded-lg border border-dashed border-zinc-700 bg-zinc-800 flex items-center justify-center">
                                  <ImageIcon className="h-6 w-6 text-zinc-600" />
                                </div>
                                <span className="text-[10px] text-zinc-600">Veo only</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-3">
                        <textarea
                          rows={3}
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder="Frame prompt..."
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                        />
                        {supportsEndFrame(editModel) && (
                          <textarea
                            rows={2}
                            value={editEndPrompt}
                            onChange={(e) => setEditEndPrompt(e.target.value)}
                            placeholder="End frame prompt (optional)..."
                            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                          />
                        )}
                        <textarea
                          rows={2}
                          value={editMotionPrompt}
                          onChange={(e) => setEditMotionPrompt(e.target.value)}
                          placeholder="Motion prompt..."
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none"
                        />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Model</span>
                            <select
                              value={editModel}
                              onChange={(e) => handleEditModelChange(e.target.value)}
                              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                            >
                              <option value="veo3">Veo 3</option>
                              <option value="ltx">LTX-2</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Resolution</span>
                            <select
                              value={editResolution}
                              onChange={(e) => setEditResolution(e.target.value)}
                              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                            >
                              {(isLtxModel(editModel) ? LTX_RESOLUTIONS : VEO_RESOLUTIONS).map((res) => (
                                <option key={res} value={res}>{res}</option>
                              ))}
                            </select>
                          </div>
                          {supportsEndFrame(editModel) && (
                            <div className="space-y-1">
                              <span className="text-[11px] uppercase tracking-wide text-zinc-500">Aspect Ratio</span>
                              <select
                                value={editAspectRatio}
                                onChange={(e) => setEditAspectRatio(e.target.value)}
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                              >
                                {VEO_ASPECT_RATIOS.map((ratio) => (
                                  <option key={ratio} value={ratio}>{ratio}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div className="space-y-1">
                            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Duration (s)</span>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={editDuration}
                              onChange={(e) => setEditDuration(Number(e.target.value))}
                              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                            />
                          </div>
                          {isLtxModel(editModel) && (
                            <div className="space-y-1">
                              <span className="text-[11px] uppercase tracking-wide text-zinc-500">FPS</span>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={editFps}
                                onChange={(e) => setEditFps(Number(e.target.value))}
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                              />
                            </div>
                          )}
                          <button
                            onClick={() => setEditGenerateAudio(!editGenerateAudio)}
                            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
                          >
                            {editGenerateAudio ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
                            {editGenerateAudio ? 'Audio On' : 'Audio Off'}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  /* View mode */
                  <>
                    {/* Header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <Clapperboard className="h-4 w-4 text-zinc-500" />
                          <h3 className="text-sm font-semibold text-zinc-100">
                            {scene.title || 'Untitled Scene'}
                          </h3>
                          {(scene.end_frame_image_id || scene.end_frame_prompt) && supportsEndFrame(scene.generation_model) && (
                            <span className="rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">End frame</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                          <span className="rounded-full bg-zinc-700 px-2 py-0.5">
                            {scene.generation_model || 'veo3'}
                          </span>
                          {scene.video_resolution && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5">{scene.video_resolution}</span>
                          )}
                          {supportsEndFrame(scene.generation_model) && scene.video_aspect_ratio && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5">{scene.video_aspect_ratio}</span>
                          )}
                          {scene.video_duration_seconds && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5">{scene.video_duration_seconds}s</span>
                          )}
                          {isLtxModel(scene.generation_model) && scene.video_fps && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5">{scene.video_fps} fps</span>
                          )}
                          {typeof scene.video_generate_audio === 'boolean' && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5">
                              {scene.video_generate_audio ? 'Audio' : 'No audio'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => startEdit(scene)}
                          className="rounded p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteId === scene.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(scene.id)}
                              className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(scene.id)}
                            className="rounded p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-700 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Frame thumbnails */}
                    <div className="flex gap-3 mb-3">
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
                        <button
                          onClick={() => openFramePicker(scene.id, 'start', 'edit')}
                          className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                          title="Click to select start frame"
                        >
                          {renderThumb(scene.start_frame_image_id, 'Start')}
                        </button>
                      </div>
                      {supportsEndFrame(scene.generation_model) ? (
                        <div className="flex flex-col items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                          <button
                            onClick={() => openFramePicker(scene.id, 'end', 'edit')}
                            className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                            title="Click to select end frame"
                          >
                            {renderThumb(scene.end_frame_image_id, 'End')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-1 opacity-50">
                          <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                          <div className="h-20 w-20 rounded-lg border border-dashed border-zinc-700 bg-zinc-800 flex items-center justify-center">
                            <ImageIcon className="h-6 w-6 text-zinc-600" />
                          </div>
                          <span className="text-[10px] text-zinc-600">Veo only</span>
                        </div>
                      )}
                    </div>

                    {/* Prompts display */}
                    {scene.prompt_text && (
                      <p className="mb-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg px-3 py-2 border border-zinc-700">
                        <span className="font-medium text-zinc-300">Frame: </span>
                        {scene.prompt_text}
                      </p>
                    )}
                    {supportsEndFrame(scene.generation_model) && scene.end_frame_prompt && (
                      <p className="mb-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg px-3 py-2 border border-blue-900/40">
                        <span className="font-medium text-blue-300">End: </span>
                        {scene.end_frame_prompt}
                      </p>
                    )}
                    {scene.motion_prompt && (
                      <p className="mb-3 text-xs text-zinc-400 bg-zinc-800 rounded-lg px-3 py-2 border border-purple-900/50">
                        <span className="font-medium text-purple-300">Motion: </span>
                        {scene.motion_prompt}
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {isGenVideo ? (
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Generating video...
                        </div>
                      ) : (
                        <button
                          onClick={() => generateVideo(scene.id)}
                          disabled={!hasFrames || !hasMotion}
                          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title={!hasMotion ? 'Add a motion prompt first' : !hasFrames ? 'Generate a start frame first' : undefined}
                        >
                          <Video className="h-3.5 w-3.5" />
                          Generate Video
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (!isExpanded) {
                            setExpandedScene(scene.id)
                            loadSceneVideos(scene.id)
                          } else {
                            setExpandedScene(null)
                          }
                        }}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 transition-colors"
                      >
                        <Film className="h-3.5 w-3.5" />
                        Videos {videos.length > 0 && `(${videos.length})`}
                      </button>
                    </div>

                    {/* Video history */}
                    {isExpanded && (
                      <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
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
                  </>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Frame picker modal */}
      {framePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="relative w-full max-w-2xl mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-200">
                Select {framePicker.slot === 'start' ? 'Start' : 'End'} Frame
              </h2>
              <button
                onClick={() => setFramePicker(null)}
                className="rounded p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-4 border-b border-zinc-700 pb-2">
              <button
                onClick={() => setPickerTab('gallery')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${pickerTab === 'gallery' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                Gallery
              </button>
              <button
                onClick={() => !uploadDisabled && setPickerTab('upload')}
                disabled={uploadDisabled}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                  pickerTab === 'upload'
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : uploadDisabled
                      ? 'text-zinc-600 cursor-not-allowed'
                      : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Upload
              </button>
            </div>

            {pickerTab === 'gallery' ? (
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
                        onClick={() => selectGalleryImage(img.id)}
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
            ) : uploadDisabled ? (
              <div className="py-8 text-center text-sm text-zinc-500">
                Upload is available after the scene is created.
              </div>
            ) : (
              <div className="py-8 flex flex-col items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFrameUpload}
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
      )}

      {/* Video playback overlay */}
      {playingVideoUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="relative w-full max-w-4xl mx-4">
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
    </div>
  )
}
