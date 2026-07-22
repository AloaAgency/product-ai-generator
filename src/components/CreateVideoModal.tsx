'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { getSafeErrorMessage } from './errorDisplay.helpers'
import { FallbackImage } from './FallbackImage'
import { api } from '@/lib/api-client'
import {
  MAX_NAME_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
  requireUuid,
} from '@/lib/request-guards'
import {
  VEO_RESOLUTIONS,
  VEO_ASPECT_RATIOS,
  DEFAULT_VEO,
} from '@/lib/video-constants'
import {
  AlertTriangle,
  Loader2,
  Video,
  X,
  ChevronDown,
  Save,
  SlidersHorizontal,
  Image as ImageIcon,
} from 'lucide-react'

// Veo can generate image-to-video without any text guidance, but a scene must
// carry a non-empty motion prompt (createSceneVideoJob rejects empty ones). When
// the user chooses to "just let it do its thing", we send this default.
const DEFAULT_MOTION_PROMPT =
  'Bring this product image to life with subtle, natural, cinematic motion. Keep the product, composition, and branding consistent and in focus.'

const fieldClassName =
  'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none'
const selectClassName =
  'w-full min-h-11 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-200 outline-none focus:border-purple-500'

interface CreateVideoModalProps {
  productId: string
  imageId: string
  previewUrl: string | null
  sourcePrompt?: string | null
  onClose: () => void
  onQueued: (message: string) => void
}

export function CreateVideoModal({
  productId,
  imageId,
  previewUrl,
  sourcePrompt,
  onClose,
  onQueued,
}: CreateVideoModalProps) {
  const fetchGenerationJobs = useAppStore((s) => s.fetchGenerationJobs)
  const fetchPromptTemplates = useAppStore((s) => s.fetchPromptTemplates)
  const createPromptTemplate = useAppStore((s) => s.createPromptTemplate)
  const updatePromptTemplate = useAppStore((s) => s.updatePromptTemplate)
  const promptTemplates = useAppStore((s) => s.promptTemplates)
  const dialogTitleId = useId()

  const [motionPrompt, setMotionPrompt] = useState('')
  const [resolution, setResolution] = useState(DEFAULT_VEO.resolution)
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_VEO.aspectRatio)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Saved-prompt recall/save
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)

  useEffect(() => {
    void fetchPromptTemplates(productId)
  }, [fetchPromptTemplates, productId])

  const videoTemplates = useMemo(
    () => promptTemplates.filter((t) => t.prompt_type === 'video'),
    [promptTemplates]
  )
  const loadedTemplate = useMemo(
    () => videoTemplates.find((t) => t.id === loadedTemplateId) ?? null,
    [videoTemplates, loadedTemplateId]
  )

  async function handleGenerate() {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const scopedProductId = requireUuid(productId, 'product id')
      const sourceImageId = requireUuid(imageId, 'image id')
      const trimmed = motionPrompt.trim()
      const finalMotionPrompt = trimmed || DEFAULT_MOTION_PROMPT
      const title = trimmed
        ? trimmed.slice(0, 80)
        : sourcePrompt?.trim()
          ? `Video: ${sourcePrompt.trim().slice(0, 70)}`
          : 'Image to video'

      // Step 1: create a start-frame-only scene (no end frame = single-frame
      // image-to-video). Duration is forced to 8s by the API when a reference
      // frame is present.
      const scene = await api(`/api/products/${encodeURIComponent(scopedProductId)}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          motion_prompt: finalMotionPrompt,
          generation_model: 'veo3',
          paired: false,
          start_frame_image_id: sourceImageId,
          end_frame_image_id: null,
          video_resolution: resolution,
          video_aspect_ratio: aspectRatio,
          video_duration_seconds: 8,
        }),
      })

      // Step 2: enqueue the Veo video job.
      const sceneId = requireUuid(String(scene?.id ?? ''), 'scene id')
      await api(`/api/products/${encodeURIComponent(scopedProductId)}/scenes/${encodeURIComponent(sceneId)}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'veo3' }),
      })

      await fetchGenerationJobs(scopedProductId)

      onQueued('Video generation queued — it will appear in the gallery once ready.')
      onClose()
    } catch (err) {
      setError(getSafeErrorMessage(err instanceof Error ? err.message : null, 'Failed to queue video generation'))
    } finally {
      setCreating(false)
    }
  }

  useModalShortcuts({
    isOpen: true,
    onClose,
    onSubmit: creating ? null : handleGenerate,
  })

  function openSaveTemplate() {
    setTemplateName(loadedTemplate?.name ?? '')
    setShowSaveTemplate(true)
  }

  async function handleSaveTemplate({ asNew }: { asNew: boolean }) {
    const name = templateName.trim()
    const text = motionPrompt.trim()
    if (!name || !text || savingTemplate) return
    setSavingTemplate(true)
    setError(null)
    try {
      if (asNew || !loadedTemplate) {
        const created = await createPromptTemplate(productId, {
          name,
          prompt_text: text,
          prompt_type: 'video',
        })
        setLoadedTemplateId(created.id)
      } else {
        await updatePromptTemplate(productId, loadedTemplate.id, {
          name,
          prompt_text: text,
        })
      }
      setShowSaveTemplate(false)
    } catch (err) {
      setError(getSafeErrorMessage(err instanceof Error ? err.message : null, 'Failed to save prompt'))
    } finally {
      setSavingTemplate(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/80 p-3 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <div
        className="relative flex max-h-[calc(100vh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 sm:max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Video className="h-5 w-5 text-purple-400" />
            <h2 id={dialogTitleId} className="text-sm font-semibold text-zinc-100">Turn image into video</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close video creation dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && (
            <div
              className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {/* Source image + intro */}
          <div className="flex gap-3">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
              <FallbackImage
                sources={[previewUrl]}
                alt="Source frame"
                className="h-full w-full object-cover"
                fallback={(
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageIcon className="h-6 w-6 text-zinc-600" />
                  </div>
                )}
              />
            </div>
            <p className="flex-1 text-xs leading-relaxed text-zinc-400">
              Veo 3.1 will animate this image as the starting frame. Add a motion prompt for direction,
              or leave it blank and let Veo decide.
            </p>
          </div>

          {/* Saved prompt recall */}
          {videoTemplates.length > 0 && (
            <div className="relative">
              <select
                className={`${selectClassName} appearance-none pr-10`}
                value={loadedTemplateId ?? ''}
                onChange={(e) => {
                  const tmpl = videoTemplates.find((t) => t.id === e.target.value)
                  if (tmpl) {
                    setMotionPrompt(tmpl.prompt_text)
                    setLoadedTemplateId(tmpl.id)
                  }
                }}
              >
                <option value="" disabled>
                  Load a saved prompt...
                </option>
                {videoTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          )}

          {/* Motion prompt */}
          <textarea
            rows={4}
            className={`${fieldClassName} resize-none`}
            placeholder="Describe the motion (optional) — e.g. 'slow push-in, product slowly rotating, soft drifting light'"
            value={motionPrompt}
            onChange={(e) => {
              setMotionPrompt(e.target.value)
              if (loadedTemplateId) setLoadedTemplateId(null)
            }}
            maxLength={MAX_PROMPT_TEXT_LENGTH}
            autoFocus
          />

          <button
            onClick={openSaveTemplate}
            disabled={!motionPrompt.trim() || savingTemplate}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-4 w-4" />
            {loadedTemplate ? 'Save prompt' : 'Save as prompt'}
          </button>

          {/* Save prompt inline form */}
          {showSaveTemplate && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                placeholder="Prompt name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-purple-500 focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && templateName.trim()) {
                    e.preventDefault()
                    handleSaveTemplate({ asNew: !loadedTemplate })
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setShowSaveTemplate(false)
                  }
                }}
              />
              <div className="flex gap-2">
                {loadedTemplate ? (
                  <>
                    <button
                      onClick={() => handleSaveTemplate({ asNew: false })}
                      disabled={!templateName.trim() || savingTemplate}
                      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-40 sm:flex-none"
                    >
                      {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
                    </button>
                    <button
                      onClick={() => handleSaveTemplate({ asNew: true })}
                      disabled={!templateName.trim() || savingTemplate}
                      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40 sm:flex-none"
                    >
                      Save as new
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleSaveTemplate({ asNew: true })}
                    disabled={!templateName.trim() || savingTemplate}
                    className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-40 sm:flex-none"
                  >
                    {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                  </button>
                )}
                <button
                  onClick={() => setShowSaveTemplate(false)}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200 sm:flex-none"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Advanced settings */}
          <div className="border-t border-zinc-800 pt-3">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Advanced settings
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
            {showAdvanced && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Resolution</span>
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    className={selectClassName}
                  >
                    {VEO_RESOLUTIONS.map((res) => (
                      <option key={res} value={res}>{res}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Aspect ratio</span>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                    className={selectClassName}
                  >
                    {VEO_ASPECT_RATIOS.map((ratio) => (
                      <option key={ratio} value={ratio}>{ratio}</option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-zinc-500 sm:col-span-2">
                  Veo 3.1 · 8s (fixed when using a start frame) · audio handled automatically.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-4">
          <button
            onClick={onClose}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={creating}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            {creating ? 'Queuing...' : 'Generate video'}
          </button>
        </div>
      </div>
    </div>
  )
}
