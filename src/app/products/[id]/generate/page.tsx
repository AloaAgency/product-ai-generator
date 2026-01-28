'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/lib/store'
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
} from 'lucide-react'

export default function GeneratePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)

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
    buildPrompt,
    suggestPrompts,
  } = useAppStore()

  const [prompt, setPrompt] = useState('')
  const [variationCount, setVariationCount] = useState(15)
  const [resolution, setResolution] = useState('2K')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [didInitDefaults, setDidInitDefaults] = useState(false)
  const [suggestions, setSuggestions] = useState<
    { name: string; prompt_text: string }[]
  >([])
  const [selectedRefSetId, setSelectedRefSetId] = useState<string>('')
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetchPromptTemplates(id)
    fetchReferenceSets(id)
  }, [id, fetchPromptTemplates, fetchReferenceSets])

  useEffect(() => {
    setDidInitDefaults(false)
  }, [id])

  useEffect(() => {
    if (!currentProduct || currentProduct.id !== id || didInitDefaults) return
    const defaults = currentProduct.global_style_settings || {}
    if (defaults.default_resolution) {
      setResolution(defaults.default_resolution)
    }
    if (defaults.default_aspect_ratio) {
      setAspectRatio(defaults.default_aspect_ratio)
    }
    setDidInitDefaults(true)
  }, [currentProduct, id, didInitDefaults])

  // Default to active reference set when sets load
  useEffect(() => {
    if (referenceSets.length > 0 && !selectedRefSetId) {
      const active = referenceSets.find((rs) => rs.is_active)
      setSelectedRefSetId(active?.id ?? referenceSets[0].id)
    }
  }, [referenceSets, selectedRefSetId])

  // Poll job status
  useEffect(() => {
    if (!activeJobId) return

    const poll = () => {
      fetchJobStatus(id, activeJobId)
    }
    poll()
    pollingRef.current = setInterval(poll, 3000)

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [activeJobId, id, fetchJobStatus])

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
    const refined = await buildPrompt(id, prompt)
    setPrompt(refined)
  }

  const handleSuggest = async () => {
    const results = await suggestPrompts(id)
    setSuggestions(results)
  }

  const handleGenerate = async () => {
    if (!prompt.trim() || aiLoading) return
    setGenerating(true)
    try {
      const job = await startGeneration(id, {
        prompt_text: prompt,
        variation_count: variationCount,
        resolution,
        aspect_ratio: aspectRatio,
        reference_set_id: selectedRefSetId || undefined,
      })
      setActiveJobId(job.id)
    } catch {
      setGenerating(false)
    }
  }

  const progress =
    currentJob && currentJob.variation_count
      ? Math.round(
          ((currentJob.completed_count ?? 0) / currentJob.variation_count) * 100
        )
      : 0

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6 space-y-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold">Generate Images</h1>

      {/* Reference Set Selector */}
      <section className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-400">Reference Set</label>
        {referenceSets.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-yellow-600 bg-yellow-950/40 px-4 py-3 text-yellow-300 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No reference sets found. Create one on the References page first.</span>
          </div>
        ) : (
          <div className="relative">
            <select
              value={selectedRefSetId}
              onChange={(e) => setSelectedRefSetId(e.target.value)}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {referenceSets.map((rs) => (
                <option key={rs.id} value={rs.id}>
                  {rs.name}{rs.is_active ? ' (Active)' : ''}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
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
                      await createPromptTemplate(id, {
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
                  await createPromptTemplate(id, {
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
              value={variationCount}
              onChange={(e) => setVariationCount(Number(e.target.value))}
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
        disabled={!prompt.trim() || !selectedRefSetId || aiLoading || generating}
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
      {currentJob && activeJobId && (
        <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-800/30 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Job Progress</h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                currentJob.status === 'completed'
                  ? 'bg-green-900/50 text-green-400'
                  : currentJob.status === 'failed'
                    ? 'bg-red-900/50 text-red-400'
                    : 'bg-blue-900/50 text-blue-400'
              }`}
            >
              {currentJob.status}
            </span>
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>
                {currentJob.completed_count ?? 0} /{' '}
                {currentJob.variation_count} images
              </span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Generated image thumbnails */}
          {currentJob.images && currentJob.images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {currentJob.images.map((img) => (
                <div
                  key={img.id}
                  className="relative aspect-square overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900"
                >
                  {(img.thumb_public_url || img.public_url) ? (
                    <img
                      src={img.thumb_public_url || img.public_url || ''}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon className="h-6 w-6 text-zinc-600" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
