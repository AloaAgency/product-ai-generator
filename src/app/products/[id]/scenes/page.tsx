'use client'

import { use, useEffect, useState, useCallback, useRef } from 'react'
import type { StoryboardScene } from '@/lib/types'
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
} from 'lucide-react'

type SignedImageUrls = {
  signed_url: string | null
  thumb_signed_url: string | null
  preview_signed_url: string | null
  expires_at: number
}

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
  params: Promise<{ id: string }>
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
  const [newMotionPrompt, setNewMotionPrompt] = useState('')
  const [newModel, setNewModel] = useState('veo3')
  const [newPaired, setNewPaired] = useState(false)
  const [creating, setCreating] = useState(false)

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [editEndPrompt, setEditEndPrompt] = useState('')
  const [editMotionPrompt, setEditMotionPrompt] = useState('')
  const [editModel, setEditModel] = useState('veo3')
  const [editPaired, setEditPaired] = useState(false)
  const [saving, setSaving] = useState(false)

  // Delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

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

  function sceneThumbUrl(imageId: string | null): string {
    if (!imageId) return ''
    void ensureSignedUrls(imageId)
    return signedUrlsById[imageId]?.thumb_signed_url || signedUrlsById[imageId]?.signed_url || ''
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

  async function loadSceneVideos(sceneId: string) {
    try {
      const data = await api(`/api/products/${id}/scenes/${sceneId}/videos`)
      setSceneVideos((prev) => ({ ...prev, [sceneId]: data.videos || [] }))
    } catch { /* ignore */ }
  }

  async function handleCreate() {
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const scene = await api(`/api/products/${id}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          prompt_text: newPrompt.trim() || null,
          motion_prompt: newMotionPrompt.trim() || null,
          generation_model: newModel,
          paired: newPaired,
        }),
      })
      setScenes((prev) => [scene, ...prev])
      setNewTitle('')
      setNewPrompt('')
      setNewMotionPrompt('')
      setNewModel('veo3')
      setNewPaired(false)
      setShowCreate(false)
    } finally {
      setCreating(false)
    }
  }

  function startEdit(scene: StoryboardScene) {
    setEditingId(scene.id)
    setEditTitle(scene.title || '')
    setEditPrompt(scene.prompt_text || '')
    setEditEndPrompt(scene.end_frame_prompt || '')
    setEditMotionPrompt(scene.motion_prompt || '')
    setEditModel(scene.generation_model || 'veo3')
    setEditPaired(scene.paired)
  }

  async function handleSave() {
    if (!editingId) return
    setSaving(true)
    try {
      const updated = await api(`/api/products/${id}/scenes/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          prompt_text: editPrompt.trim() || null,
          end_frame_prompt: editEndPrompt.trim() || null,
          motion_prompt: editMotionPrompt.trim() || null,
          generation_model: editModel,
          paired: editPaired,
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
          <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-5 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">Create Scene</h2>
            <input
              type="text"
              placeholder="Scene title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <textarea
              rows={3}
              placeholder="Frame prompt (still image description)..."
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
            />
            <textarea
              rows={2}
              placeholder="Motion prompt (video/motion description)..."
              value={newMotionPrompt}
              onChange={(e) => setNewMotionPrompt(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none"
            />
            <div className="flex items-center gap-3">
              <select
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
              >
                <option value="veo3">Veo 3</option>
                <option value="ltx">LTX Video</option>
              </select>
              <button
                onClick={() => setNewPaired(!newPaired)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
              >
                {newPaired ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
                {newPaired ? 'Paired' : 'Single'}
              </button>
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
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                    />
                    <textarea
                      rows={3}
                      value={editPrompt}
                      onChange={(e) => setEditPrompt(e.target.value)}
                      placeholder="Frame prompt..."
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                    />
                    {editPaired && (
                      <textarea
                        rows={3}
                        value={editEndPrompt}
                        onChange={(e) => setEditEndPrompt(e.target.value)}
                        placeholder="End frame prompt..."
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
                    <div className="flex items-center gap-3">
                      <select
                        value={editModel}
                        onChange={(e) => setEditModel(e.target.value)}
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                      >
                        <option value="veo3">Veo 3</option>
                        <option value="ltx">LTX Video</option>
                      </select>
                      <button
                        onClick={() => setEditPaired(!editPaired)}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
                      >
                        {editPaired ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
                        {editPaired ? 'Paired' : 'Single'}
                      </button>
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
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Clapperboard className="h-4 w-4 text-zinc-500" />
                        <h3 className="text-sm font-semibold text-zinc-100">
                          {scene.title || 'Untitled Scene'}
                        </h3>
                        {scene.paired && (
                          <span className="rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">Paired</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="rounded-full bg-zinc-700 px-2 py-0.5 text-xs text-zinc-400 mr-2">
                          {scene.generation_model || 'veo3'}
                        </span>
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
                        <div className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center">
                          {scene.start_frame_image_id ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={sceneThumbUrl(scene.start_frame_image_id)} alt="Start" className="h-full w-full object-cover" />
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
                              <img src={sceneThumbUrl(scene.end_frame_image_id)} alt="End" className="h-full w-full object-cover" />
                            ) : (
                              <ImageIcon className="h-6 w-6 text-zinc-600" />
                            )}
                          </div>
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
