'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useAppStore } from '@/lib/store'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import {
  Sparkles,
  Lightbulb,
  Loader2,
  AlertTriangle,
  Image as ImageIcon,
  Play,
  ChevronDown,
  Settings,
  Save,
  X,
} from 'lucide-react'
import { PromptEnhancements } from './PromptEnhancements'
import { ReferenceImagePicker } from './ReferenceImagePicker'
import { assemblePrompt, DEFAULT_ENHANCEMENTS, type PromptEnhancementValues } from './promptAssembler'

interface ImageGenerateTabProps {
  productId: string
}

export function ImageGenerateTab({ productId }: ImageGenerateTabProps) {
  const {
    promptTemplates,
    referenceSets,
    currentJob,
    currentProduct,
    aiLoading,
    fetchPromptTemplates,
    createPromptTemplate,
    fetchReferenceSets,
    startGeneration,
    fetchJobStatus,
    retryGenerationJob,
    buildPrompt,
    suggestPrompts,
    updateImageApproval,
    deleteImage,
  } = useAppStore()

  const [prompt, setPrompt] = useState('')
  const [variationCountInput, setVariationCountInput] = useState('15')
  const [resolution, setResolution] = useState('2K')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [didInitDefaults, setDidInitDefaults] = useState(false)
  const [suggestions, setSuggestions] = useState<
    { name: string; prompt_text: string }[]
  >([])
  const [selectedRefSetId, setSelectedRefSetId] = useState<string>('')
  const [selectedTextureSetId, setSelectedTextureSetId] = useState<string>('')
  const [productImageCountInput, setProductImageCountInput] = useState('10')
  const [textureImageCountInput, setTextureImageCountInput] = useState('4')
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, { signed_url?: string | null; thumb_signed_url?: string | null; preview_signed_url?: string | null; expires_at?: number }>>({})
  const signedUrlsRef = useRef(signedUrlsById)
  useEffect(() => { signedUrlsRef.current = signedUrlsById }, [signedUrlsById])

  // Prompt enhancements
  const [enhancements, setEnhancements] = useState<PromptEnhancementValues>(DEFAULT_ENHANCEMENTS)

  // Reference image
  const [referenceImageId, setReferenceImageId] = useState<string | null>(null)
  const [referenceThumbUrl, setReferenceThumbUrl] = useState<string | null>(null)
  const [showRefPicker, setShowRefPicker] = useState(false)

  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) return cached
    const res = await fetch(`/api/images/${imageId}/signed`)
    if (!res.ok) return null
    const data = await res.json()
    const next = { ...signedUrlsRef.current, [imageId]: data }
    signedUrlsRef.current = next
    setSignedUrlsById(next)
    return data
  }, [])

  useEffect(() => {
    fetchPromptTemplates(productId)
    fetchReferenceSets(productId)
  }, [productId, fetchPromptTemplates, fetchReferenceSets])

  useEffect(() => {
    setDidInitDefaults(false)
  }, [productId])

  useEffect(() => {
    if (!currentProduct || currentProduct.id !== productId || didInitDefaults) return
    const defaults = currentProduct.global_style_settings || {}
    if (defaults.default_resolution) {
      setResolution(defaults.default_resolution)
    }
    if (defaults.default_aspect_ratio) {
      setAspectRatio(defaults.default_aspect_ratio)
    }
    if (defaults.default_variation_count) {
      setVariationCountInput(String(defaults.default_variation_count))
    }
    setDidInitDefaults(true)
  }, [currentProduct, productId, didInitDefaults])

  // Filter sets by type
  const productSets = referenceSets.filter((rs) => rs.type === 'product' || !rs.type)
  const textureSets = referenceSets.filter((rs) => rs.type === 'texture')

  // Default to active reference set when sets load
  useEffect(() => {
    if (productSets.length > 0 && !selectedRefSetId) {
      const active = productSets.find((rs) => rs.is_active)
      setSelectedRefSetId(active?.id ?? productSets[0].id)
    }
  }, [productSets, selectedRefSetId])

  // Poll job status
  useEffect(() => {
    if (!activeJobId) return
    const poll = () => { fetchJobStatus(productId, activeJobId) }
    poll()
    pollingRef.current = setInterval(poll, 3000)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [activeJobId, productId, fetchJobStatus])

  // Stop polling when job is done
  useEffect(() => {
    if (
      currentJob &&
      (currentJob.status === 'completed' || currentJob.status === 'failed')
    ) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      setGenerating(false)
    }
  }, [currentJob?.status])

  const handleRefine = async () => {
    if (!prompt.trim()) return
    const refined = await buildPrompt(productId, prompt)
    setPrompt(refined)
  }

  const handleSuggest = async () => {
    const results = await suggestPrompts(productId)
    setSuggestions(results)
  }

  const handleGenerate = async () => {
    if (!prompt.trim() || aiLoading) return
    const variationCountValue = parseVariationCount(variationCountInput)
    if (!variationCountValue) return
    if (selectedTextureSetId && (!productImageCountValue || !textureImageCountValue)) return

    // Assemble prompt with enhancements
    let finalPrompt = assemblePrompt(prompt, enhancements)
    if (referenceImageId) {
      finalPrompt += ' Use the attached reference image for visual guidance.'
    }

    setGenerating(true)
    try {
      const job = await startGeneration(productId, {
        prompt_text: finalPrompt,
        variation_count: variationCountValue,
        resolution,
        aspect_ratio: aspectRatio,
        reference_set_id: selectedRefSetId || undefined,
        texture_set_id: selectedTextureSetId || undefined,
        product_image_count: selectedTextureSetId ? productImageCountValue ?? undefined : undefined,
        texture_image_count: selectedTextureSetId ? textureImageCountValue ?? undefined : undefined,
      })
      setActiveJobId(job.id)
    } catch {
      setGenerating(false)
    }
  }

  const handleRetry = async () => {
    if (!currentJob) return
    setRetrying(true)
    try {
      const job = await retryGenerationJob(productId, currentJob.id)
      setGenerating(true)
      setActiveJobId(null)
      setTimeout(() => setActiveJobId(job.id), 0)
    } finally {
      setRetrying(false)
    }
  }

  const lightboxImages: LightboxImage[] = useMemo(() => {
    if (!currentJob?.images) return []
    return currentJob.images.map((img) => ({
      id: img.id,
      public_url: img.public_url,
      thumb_public_url: img.thumb_public_url,
      preview_public_url: img.preview_public_url,
      signed_url: signedUrlsById[img.id]?.signed_url ?? null,
      thumb_signed_url: signedUrlsById[img.id]?.thumb_signed_url ?? null,
      preview_signed_url: signedUrlsById[img.id]?.preview_signed_url ?? null,
      file_name: img.storage_path?.split('/').pop() ?? null,
      variation_number: img.variation_number,
      approval_status: img.approval_status ?? 'pending',
      notes: img.notes,
    }))
  }, [currentJob?.images, signedUrlsById])

  const handleApprovalChange = async (imageId: string, status: ApprovalStatus) => {
    if (status === 'rejected') {
      await deleteImage(imageId)
    } else {
      await updateImageApproval(imageId, status)
    }
  }

  const completedOrImages = currentJob
    ? Math.max(currentJob.completed_count ?? 0, currentJob.images?.length ?? 0)
    : 0
  const progress =
    currentJob && currentJob.variation_count
      ? Math.round((completedOrImages / currentJob.variation_count) * 100)
      : 0

  const parseVariationCount = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 1) return null
    return Math.min(100, parsed)
  }
  const variationCountValue = parseVariationCount(variationCountInput)
  const parseImageCount = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 1) return null
    return Math.min(14, parsed)
  }
  const productImageCountValue = parseImageCount(productImageCountInput)
  const textureImageCountValue = parseImageCount(textureImageCountInput)
  const totalImageCount = (productImageCountValue ?? 0) + (textureImageCountValue ?? 0)

  const failedCount = currentJob?.failed_count ?? 0
  const hasFailures = failedCount > 0
  const errorMessage = currentJob?.error_message
  const canRetry = !!currentJob && (currentJob.status === 'failed' || ((currentJob.completed_count ?? 0) === 0 && failedCount > 0))
  const displayStatus = currentJob
    ? (canRetry && currentJob.status !== 'failed' ? 'failed' : currentJob.status)
    : null

  return (
    <div className="space-y-8">
      {/* Reference Set Selectors */}
      <section className="space-y-4">
        {/* Product Reference Set */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-400">Product Reference Set</label>
          {productSets.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-600 bg-yellow-950/40 px-4 py-3 text-yellow-300 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>No product reference sets found. Create one on the References page first.</span>
            </div>
          ) : (
            <div className="relative">
              <select
                value={selectedRefSetId}
                onChange={(e) => setSelectedRefSetId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                {productSets.map((rs) => (
                  <option key={rs.id} value={rs.id}>
                    {rs.name}{rs.is_active ? ' (Active)' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          )}
        </div>

        {/* Texture Reference Set (Optional) */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-400">Texture Reference Set (Optional)</label>
          <div className="relative">
            <select
              value={selectedTextureSetId}
              onChange={(e) => setSelectedTextureSetId(e.target.value)}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="">None</option>
              {textureSets.map((rs) => (
                <option key={rs.id} value={rs.id}>
                  {rs.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
          {textureSets.length === 0 && (
            <p className="text-xs text-zinc-500">
              No texture sets available. Create one on the References page to use texture references.
            </p>
          )}
        </div>

        {/* Image Allocation Controls */}
        {selectedTextureSetId && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-300">Image Allocation</span>
              <span className={`text-xs ${totalImageCount > 14 ? 'text-red-400' : 'text-zinc-500'}`}>
                Total: {totalImageCount} / 14 max
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">Product Images</label>
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={productImageCountInput}
                  onChange={(e) => setProductImageCountInput(e.target.value)}
                  onBlur={() => {
                    const parsed = parseImageCount(productImageCountInput)
                    setProductImageCountInput(String(parsed ?? 1))
                  }}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">Texture Images</label>
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={textureImageCountInput}
                  onChange={(e) => setTextureImageCountInput(e.target.value)}
                  onBlur={() => {
                    const parsed = parseImageCount(textureImageCountInput)
                    setTextureImageCountInput(String(parsed ?? 1))
                  }}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            {totalImageCount > 14 && (
              <div className="flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>Total image count exceeds the maximum of 14. Please reduce the counts.</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Prompt Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Prompt</h2>

        {/* Template dropdown */}
        {promptTemplates.length > 0 && (
          <div className="relative">
            <select
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              defaultValue=""
              onChange={(e) => {
                const tmpl = promptTemplates.find((t) => t.id === e.target.value)
                if (tmpl) setPrompt(tmpl.prompt_text)
              }}
            >
              <option value="" disabled>
                Load from template...
              </option>
              {promptTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
        )}

        <textarea
          rows={5}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
          placeholder="Describe the product image you want to generate..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="flex gap-3">
          <button
            onClick={handleRefine}
            disabled={aiLoading || !prompt.trim()}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {aiLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AI Refine
          </button>
          <button
            onClick={handleSuggest}
            disabled={aiLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {aiLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Lightbulb className="h-4 w-4" />
            )}
            AI Suggest
          </button>
          <button
            onClick={() => setShowSaveTemplate(true)}
            disabled={!prompt.trim() || savingTemplate}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="h-4 w-4" />
            Save as Template
          </button>
        </div>

        {/* Save as Template inline form */}
        {showSaveTemplate && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && templateName.trim()) {
                  (async () => {
                    setSavingTemplate(true)
                    try {
                      await createPromptTemplate(productId, {
                        name: templateName.trim(),
                        prompt_text: prompt,
                      })
                      setTemplateName('')
                      setShowSaveTemplate(false)
                    } finally {
                      setSavingTemplate(false)
                    }
                  })()
                }
                if (e.key === 'Escape') setShowSaveTemplate(false)
              }}
            />
            <button
              onClick={async () => {
                if (!templateName.trim()) return
                setSavingTemplate(true)
                try {
                  await createPromptTemplate(productId, {
                    name: templateName.trim(),
                    prompt_text: prompt,
                  })
                  setTemplateName('')
                  setShowSaveTemplate(false)
                } finally {
                  setSavingTemplate(false)
                }
              }}
              disabled={!templateName.trim() || savingTemplate}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
            >
              {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </button>
            <button
              onClick={() => setShowSaveTemplate(false)}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setPrompt(s.prompt_text)
                  setSuggestions([])
                }}
                className="text-left rounded-lg border border-zinc-800 bg-zinc-800/50 p-4 hover:border-blue-500 hover:bg-zinc-800 transition-colors"
              >
                <p className="text-sm font-medium text-zinc-200">{s.name}</p>
                <p className="mt-1 text-xs text-zinc-400 line-clamp-3">
                  {s.prompt_text}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Prompt Enhancements */}
      <PromptEnhancements values={enhancements} onChange={setEnhancements} />

      {/* Reference Image */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Reference Image</h2>
        <div className="flex items-center gap-3">
          {referenceImageId && referenceThumbUrl ? (
            <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceThumbUrl} alt="Reference" className="h-full w-full object-cover" />
              <button
                onClick={() => { setReferenceImageId(null); setReferenceThumbUrl(null) }}
                className="absolute -top-1 -right-1 rounded-full bg-zinc-900 border border-zinc-700 p-0.5 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              onClick={() => setShowRefPicker(true)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {referenceImageId ? 'Change' : 'Attach Reference'}
            </button>
            {referenceImageId && (
              <button
                onClick={() => { setReferenceImageId(null); setReferenceThumbUrl(null) }}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Settings Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Settings
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Variations
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={variationCountInput}
              onChange={(e) => setVariationCountInput(e.target.value)}
              onBlur={() => {
                const parsed = parseVariationCount(variationCountInput)
                setVariationCountInput(String(parsed ?? 1))
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Resolution
            </label>
            <div className="relative">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Aspect Ratio
            </label>
            <div className="relative">
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="9:16">9:16</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
        </div>
      </section>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={
          !prompt.trim() ||
          !selectedRefSetId ||
          aiLoading ||
          generating ||
          !variationCountValue ||
          (!!selectedTextureSetId &&
            ((productImageCountValue ?? 0) < 1 ||
              (textureImageCountValue ?? 0) < 1 ||
              totalImageCount > 14))
        }
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {generating ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Play className="h-5 w-5" />
        )}
        {generating ? 'Generating...' : 'Generate Images'}
      </button>

      {/* Active Job Monitor */}
      {currentJob && activeJobId && (displayStatus === 'running' || displayStatus === 'pending' || displayStatus === 'completed' || displayStatus === 'failed') && (
        <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-800/30 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Job Progress</h2>
            <div className="flex items-center gap-2">
              {canRetry && (
                <button
                  onClick={handleRetry}
                  disabled={retrying || generating}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {retrying ? 'Retrying...' : 'Retry'}
                </button>
              )}
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  displayStatus === 'completed'
                    ? 'bg-green-900/50 text-green-400'
                    : displayStatus === 'failed'
                      ? 'bg-red-900/50 text-red-400'
                      : 'bg-blue-900/50 text-blue-400'
                }`}
              >
                {displayStatus}
              </span>
            </div>
          </div>

          {errorMessage && (
            <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
              <span className="font-medium">Error:</span> {errorMessage}
            </div>
          )}

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>
                {displayStatus === 'pending' ? (
                  'Starting generation...'
                ) : displayStatus === 'completed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''} — Complete
                  </>
                ) : displayStatus === 'failed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images · {failedCount} failed
                  </>
                ) : completedOrImages === 0 ? (
                  'Generating images...'
                ) : (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''}
                  </>
                )}
              </span>
              {(displayStatus !== 'pending' && !(displayStatus === 'running' && completedOrImages === 0)) && (
                <span>{progress}%</span>
              )}
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
              {displayStatus === 'completed' ? (
                <div className="h-full w-full rounded-full bg-green-500 transition-all duration-500" />
              ) : displayStatus === 'failed' ? (
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-500"
                  style={{ width: `${Math.max(progress, 5)}%` }}
                />
              ) : (displayStatus === 'pending' || (displayStatus === 'running' && completedOrImages === 0)) ? (
                <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse-bar" />
              ) : (
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
          </div>

          {/* Generated image thumbnails */}
          {currentJob.images && currentJob.images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {currentJob.images.map((img, index) => (
                <button
                  key={img.id}
                  onClick={() => setLightboxIndex(index)}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 hover:border-zinc-500 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500"
                >
                  {(img.thumb_public_url || img.public_url) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img.thumb_public_url || img.public_url || ''}
                      alt=""
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon className="h-6 w-6 text-zinc-600" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}

      {/* Reference Image Picker Modal */}
      <ReferenceImagePicker
        isOpen={showRefPicker}
        onClose={() => setShowRefPicker(false)}
        onSelect={(imageId, thumbUrl) => {
          setReferenceImageId(imageId)
          setReferenceThumbUrl(thumbUrl)
          setShowRefPicker(false)
        }}
        productId={productId}
      />
    </div>
  )
}
