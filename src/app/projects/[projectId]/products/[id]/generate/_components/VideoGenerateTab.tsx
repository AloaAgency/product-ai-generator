'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import type { GeneratedImage } from '@/lib/types'
import {
  Loader2,
  Video,
  X,
  Image as ImageIcon,
  Upload,
  ToggleLeft,
  ToggleRight,
  Check,
} from 'lucide-react'
import {
  VEO_RESOLUTIONS,
  VEO_ASPECT_RATIOS,
  VEO_DURATIONS,
  LTX_RESOLUTIONS,
  DEFAULT_VEO,
  DEFAULT_LTX,
  isLtxModel,
  supportsEndFrame,
  supportsAudioToggle,
  veoRequires8s,
  normalizeDurationValue,
  parsePositiveNumber,
} from '@/lib/video-constants'

interface VideoGenerateTabProps {
  productId: string
}

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

export function VideoGenerateTab({ productId }: VideoGenerateTabProps) {
  const { fetchGenerationJobs } = useAppStore()

  // Scene form state
  const [title, setTitle] = useState('')
  const [framePrompt, setFramePrompt] = useState('')
  const [endFramePrompt, setEndFramePrompt] = useState('')
  const [motionPrompt, setMotionPrompt] = useState('')
  const [model, setModel] = useState('veo3')
  const [startFrameId, setStartFrameId] = useState<string | null>(null)
  const [endFrameId, setEndFrameId] = useState<string | null>(null)
  const [resolution, setResolution] = useState(DEFAULT_VEO.resolution)
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_VEO.aspectRatio)
  const [durationInput, setDurationInput] = useState(String(DEFAULT_VEO.duration))
  const [fpsInput, setFpsInput] = useState(String(DEFAULT_LTX.fps))
  const [generateAudio, setGenerateAudio] = useState(DEFAULT_VEO.generateAudio)

  // UI state
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<{ type: 'info' | 'error'; message: string } | null>(null)

  // Frame picker
  const [framePicker, setFramePicker] = useState<{ slot: 'start' | 'end' } | null>(null)
  const [pickerTab, setPickerTab] = useState<'gallery' | 'upload'>('gallery')
  const [galleryImages, setGalleryImages] = useState<GeneratedImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Signed URLs for frame thumbnails
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

  useModalShortcuts({
    isOpen: !!framePicker,
    onClose: () => setFramePicker(null),
  })

  async function openFramePicker(slot: 'start' | 'end') {
    setFramePicker({ slot })
    setPickerTab('gallery')
    setLoadingGallery(true)
    try {
      const data = await api(`/api/products/${productId}/gallery?media_type=image&approval_status=approved`)
      setGalleryImages(data.images ?? data)
    } catch {
      setGalleryImages([])
    } finally {
      setLoadingGallery(false)
    }
  }

  function selectGalleryImage(imageId: string) {
    if (!framePicker) return
    if (framePicker.slot === 'start') {
      setStartFrameId(imageId)
    } else {
      setEndFrameId(imageId)
    }
    setFramePicker(null)
  }

  async function handleFrameUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !framePicker) return
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
      if (framePicker.slot === 'start') {
        setStartFrameId(firstResult.image.id)
      } else {
        setEndFrameId(firstResult.image.id)
      }
      setFramePicker(null)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function handleModelChange(value: string) {
    setModel(value)
    if (isLtxModel(value)) {
      setResolution(DEFAULT_LTX.resolution)
      setDurationInput(String(DEFAULT_LTX.duration))
      setFpsInput(String(DEFAULT_LTX.fps))
      setGenerateAudio(DEFAULT_LTX.generateAudio)
    } else {
      setResolution(DEFAULT_VEO.resolution)
      setAspectRatio(DEFAULT_VEO.aspectRatio)
      setDurationInput(String(DEFAULT_VEO.duration))
      setGenerateAudio(DEFAULT_VEO.generateAudio)
    }
  }

  async function handleGenerateVideo() {
    if (!title.trim()) return
    setCreating(true)
    setNotice(null)
    try {
      const allowEndFrame = supportsEndFrame(model)
      const endPrompt = allowEndFrame ? endFramePrompt.trim() || null : null
      const endFrame = allowEndFrame ? endFrameId : null
      const paired = allowEndFrame && (!!endFrame || !!endPrompt)
      const duration = parsePositiveNumber(durationInput)
      const fps = parsePositiveNumber(fpsInput)
      const durationValue = normalizeDurationValue(model, duration, resolution, !!startFrameId, !!endFrame)
      const fpsValue = isLtxModel(model) && fps ? fps : null
      const audioValue = generateAudio

      // Step 1: Create the scene
      const scene = await api(`/api/products/${productId}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          prompt_text: framePrompt.trim() || null,
          end_frame_prompt: endPrompt,
          motion_prompt: motionPrompt.trim() || null,
          generation_model: model,
          paired,
          start_frame_image_id: startFrameId || null,
          end_frame_image_id: endFrame || null,
          video_resolution: resolution || null,
          video_aspect_ratio: allowEndFrame ? aspectRatio || null : null,
          video_duration_seconds: durationValue,
          video_fps: fpsValue,
          video_generate_audio: audioValue,
        }),
      })

      // Step 2: Trigger video generation
      await api(`/api/products/${productId}/scenes/${scene.id}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })

      await fetchGenerationJobs(productId)

      setNotice({
        type: 'info',
        message: `Scene "${title.trim()}" created and video generation queued. Check the generation queue for progress.`,
      })

      // Reset form
      setTitle('')
      setFramePrompt('')
      setEndFramePrompt('')
      setMotionPrompt('')
      setModel('veo3')
      setStartFrameId(null)
      setEndFrameId(null)
      setResolution(DEFAULT_VEO.resolution)
      setAspectRatio(DEFAULT_VEO.aspectRatio)
      setDurationInput(String(DEFAULT_VEO.duration))
      setFpsInput(String(DEFAULT_LTX.fps))
      setGenerateAudio(DEFAULT_VEO.generateAudio)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create scene or queue video'
      setNotice({ type: 'error', message })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Notice */}
      {notice && (
        <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
          notice.type === 'error'
            ? 'border-red-900/50 bg-red-950/30 text-red-300'
            : 'border-blue-900/50 bg-blue-950/30 text-blue-300'
        }`}>
          <span className="flex-1">{notice.message}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 text-current opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Scene form */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-5 space-y-4">
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1.4fr]">
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Scene title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Key frames</span>
                {!supportsEndFrame(model) && (
                  <span className="text-[10px] text-zinc-500">LTX uses the start frame only</span>
                )}
              </div>
              <div className="flex gap-3">
                <div className="flex flex-col items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
                  <button
                    onClick={() => openFramePicker('start')}
                    className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                    title="Select start frame"
                  >
                    {renderThumb(startFrameId, 'Start')}
                  </button>
                  {startFrameId && (
                    <button
                      onClick={() => setStartFrameId(null)}
                      className="text-[10px] text-zinc-500 hover:text-zinc-300"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {supportsEndFrame(model) ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-500">End</span>
                    <button
                      onClick={() => openFramePicker('end')}
                      className="h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center hover:border-blue-500 transition-colors cursor-pointer"
                      title="Select end frame"
                    >
                      {renderThumb(endFrameId, 'End')}
                    </button>
                    {endFrameId && (
                      <button
                        onClick={() => setEndFrameId(null)}
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
              value={framePrompt}
              onChange={(e) => setFramePrompt(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
            />
            {supportsEndFrame(model) && (
              <textarea
                rows={2}
                placeholder="End frame prompt (optional)..."
                value={endFramePrompt}
                onChange={(e) => setEndFramePrompt(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
              />
            )}
            <textarea
              rows={2}
              placeholder="Motion prompt (video/motion description)..."
              value={motionPrompt}
              onChange={(e) => setMotionPrompt(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">Model</span>
                <select
                  value={model}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                >
                  <option value="veo3">Veo 3</option>
                  <option value="ltx">LTX-2</option>
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">Resolution</span>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                >
                  {(isLtxModel(model) ? LTX_RESOLUTIONS : VEO_RESOLUTIONS).map((res) => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>
              </div>
              {supportsEndFrame(model) && (
                <div className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Aspect Ratio</span>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
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
                {isLtxModel(model) ? (
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={durationInput}
                    onChange={(e) => setDurationInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parsePositiveNumber(durationInput)
                      setDurationInput(String(parsed ?? 1))
                    }}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                  />
                ) : veoRequires8s(resolution, !!startFrameId, !!endFrameId) ? (
                  <>
                    <select
                      value={8}
                      disabled
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none opacity-60 cursor-not-allowed"
                    >
                      <option value={8}>8</option>
                    </select>
                    <p className="text-[10px] text-zinc-500 mt-1">Must be 8s with reference images or 1080p/4k.</p>
                  </>
                ) : (
                  <select
                    value={normalizeDurationValue(model, durationInput, resolution, !!startFrameId, !!endFrameId) ?? DEFAULT_VEO.duration}
                    onChange={(e) => setDurationInput(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                  >
                    {VEO_DURATIONS.map((duration) => (
                      <option key={duration} value={duration}>{duration}</option>
                    ))}
                  </select>
                )}
              </div>
              {isLtxModel(model) && (
                <div className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">FPS</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={fpsInput}
                    onChange={(e) => setFpsInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parsePositiveNumber(fpsInput)
                      setFpsInput(String(parsed ?? 1))
                    }}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none"
                  />
                </div>
              )}
              <div className="flex flex-col items-start">
                <button
                  onClick={() => setGenerateAudio(!generateAudio)}
                  disabled={!supportsAudioToggle(model)}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                  title={!supportsAudioToggle(model) ? 'Audio toggle is supported for LTX only' : undefined}
                >
                  {generateAudio ? <ToggleRight className="h-4 w-4 text-blue-400" /> : <ToggleLeft className="h-4 w-4" />}
                  {generateAudio ? 'Audio On' : 'Audio Off'}
                </button>
                {!supportsAudioToggle(model) && (
                  <span className="mt-1 text-[10px] text-zinc-500">Audio toggle is LTX-only.</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Generate Video Button */}
        <button
          onClick={handleGenerateVideo}
          disabled={creating || !title.trim() || !motionPrompt.trim()}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-purple-600 px-6 py-3 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {creating ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Video className="h-5 w-5" />
          )}
          {creating ? 'Creating & Generating...' : 'Generate Video'}
        </button>
        {!motionPrompt.trim() && title.trim() && (
          <p className="text-xs text-zinc-500">A motion prompt is required to generate a video.</p>
        )}
      </div>

      {/* Frame picker modal */}
      {framePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setFramePicker(null)}>
          <div className="relative w-full max-w-2xl mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
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
                onClick={() => setPickerTab('upload')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${pickerTab === 'upload' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
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
    </div>
  )
}
