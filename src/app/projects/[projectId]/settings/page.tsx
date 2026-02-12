'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { Save, CheckCircle, Settings, Camera, Palette, Trash2, ArrowLeft, Key, ChevronDown, Plus } from 'lucide-react'
import type { GlobalStyleSettings, GoogleApiKeyConfig } from '@/lib/types'
import { createGoogleApiKeyId, normalizeGoogleApiKeySettings } from '@/lib/google-api-keys'

function SectionCard({
  id,
  icon: Icon,
  title,
  description,
  expanded,
  onToggle,
  children,
}: {
  id: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-zinc-800 p-2">
            <Icon className="h-4 w-4 text-zinc-400" />
          </div>
          <div>
            <h2 className="font-medium text-zinc-100">{title}</h2>
            {description && <p className="text-xs text-zinc-500">{description}</p>}
          </div>
        </div>
        <ChevronDown
          className={`h-5 w-5 text-zinc-500 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  )
}

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = use(params)
  const router = useRouter()
  const { currentProject, fetchProject, updateProject, deleteProject } = useAppStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [settings, setSettings] = useState<GlobalStyleSettings>({})
  const [defaultVariationInput, setDefaultVariationInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    style: true,
    output: true,
    api: true,
  })

  const initializedForId = useRef<string | null>(null)

  useEffect(() => {
    fetchProject(projectId)
  }, [projectId, fetchProject])

  useEffect(() => {
    if (currentProject && initializedForId.current !== projectId) {
      initializedForId.current = projectId
      setName(currentProject.name)
      setDescription(currentProject.description || '')
      const defaults = normalizeGoogleApiKeySettings(currentProject.global_style_settings || {})
      setSettings(defaults)
      setDefaultVariationInput(
        typeof defaults.default_variation_count === 'number'
          ? String(defaults.default_variation_count)
          : ''
      )
    }
  }, [currentProject, projectId])

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const updateField = (key: keyof GlobalStyleSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value || undefined }))
  }

  const parseVariationValue = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    return Math.min(50, Math.max(1, parsed))
  }

  const updateGoogleApiKeys = (updater: (keys: GoogleApiKeyConfig[]) => GoogleApiKeyConfig[]) => {
    setSettings((prev) => {
      const currentKeys = Array.isArray(prev.google_api_keys) ? prev.google_api_keys : []
      const nextKeys = updater(currentKeys)
      // Only recompute active ID when the current active key was removed
      const activeId = nextKeys.some((item) => item.id === prev.active_google_api_key_id)
        ? prev.active_google_api_key_id
        : nextKeys[0]?.id
      return {
        ...prev,
        google_api_keys: nextKeys.length > 0 ? nextKeys : undefined,
        active_google_api_key_id: activeId,
      }
    })
  }

  const setActiveGoogleApiKey = (id: string) => {
    setSettings((prev) => ({
      ...prev,
      active_google_api_key_id: id,
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const normalizedSettings = normalizeGoogleApiKeySettings(settings)
      await updateProject(projectId, {
        name,
        description: description || undefined,
        global_style_settings: normalizedSettings,
      })
      setSettings(normalizedSettings)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
      </div>
    )
  }

  const inputClasses = 'w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 transition-colors focus:border-zinc-500 focus:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-500'

  const textInput = (label: string, key: keyof GlobalStyleSettings, placeholder?: string) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-400">{label}</label>
      <input
        type="text"
        value={(settings[key] as string) || ''}
        onChange={(e) => updateField(key, e.target.value)}
        placeholder={placeholder}
        className={inputClasses}
      />
    </div>
  )

  const textArea = (label: string, key: keyof GlobalStyleSettings, placeholder?: string) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-400">{label}</label>
      <textarea
        rows={2}
        value={(settings[key] as string) || ''}
        onChange={(e) => updateField(key, e.target.value)}
        placeholder={placeholder}
        className={`${inputClasses} resize-y`}
      />
    </div>
  )

  const dropdown = (label: string, key: keyof GlobalStyleSettings, options: string[]) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-400">{label}</label>
      <select
        value={(settings[key] as string) || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className={inputClasses}
      >
        <option value="">Not set</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  )

  const googleApiKeys = Array.isArray(settings.google_api_keys) ? settings.google_api_keys : []
  const activeGoogleApiKeyId =
    settings.active_google_api_key_id || googleApiKeys[0]?.id || ''

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <Link
            href={`/projects/${projectId}`}
            className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Project
          </Link>

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
                <Settings className="h-5 w-5 sm:h-6 sm:w-6 text-zinc-500" />
                Project Settings
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                Configure defaults for all products in this project
              </p>
            </div>
          </div>
        </div>

        {/* Project Info Card */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-400">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClasses}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-400">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this project..."
              className={`${inputClasses} resize-y`}
            />
          </div>
        </div>

        {/* Style Settings */}
        <SectionCard
          id="style"
          icon={Palette}
          title="Default Style Settings"
          description="Photography and visual style defaults"
          expanded={expandedSections.style}
          onToggle={() => toggleSection('style')}
        >
          <div className="grid gap-4">
            {textArea('Subject Rule', 'subject_rule', 'How the product should be framed...')}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {textInput('Lens', 'lens', 'e.g., 85mm f/1.4')}
              {textInput('Camera Height', 'camera_height', 'e.g., Eye level')}
            </div>
            {textArea('Color Grading', 'color_grading', 'Color treatment and mood...')}
            {textInput('Lighting', 'lighting', 'e.g., Soft key light with rim accent')}
            {textArea('Style', 'style', 'Overall visual style...')}
            {textArea('Constraints', 'constraints', 'Things to avoid in generation...')}
            {textArea('Reference Rule', 'reference_rule', 'How reference images should be used...')}
            {textArea('Custom Suffix', 'custom_suffix', 'Text appended to every prompt...')}
          </div>
        </SectionCard>

        {/* Output Settings */}
        <SectionCard
          id="output"
          icon={Camera}
          title="Default Output Settings"
          description="Resolution, aspect ratio, and generation defaults"
          expanded={expandedSections.output}
          onToggle={() => toggleSection('output')}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {dropdown('Resolution', 'default_resolution', ['2K', '4K'])}
            {dropdown('Aspect Ratio', 'default_aspect_ratio', ['16:9', '1:1', '9:16'])}
            {textInput('Fidelity', 'default_fidelity')}
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-zinc-400">Variations</label>
              <input
                type="number"
                min={1}
                max={50}
                value={defaultVariationInput}
                onChange={(e) => {
                  const next = e.target.value
                  setDefaultVariationInput(next)
                  const parsed = parseVariationValue(next)
                  setSettings((prev) => ({
                    ...prev,
                    default_variation_count: parsed ?? undefined,
                  }))
                }}
                onBlur={() => {
                  const parsed = parseVariationValue(defaultVariationInput)
                  setDefaultVariationInput(parsed ? String(parsed) : '')
                  setSettings((prev) => ({
                    ...prev,
                    default_variation_count: parsed ?? undefined,
                  }))
                }}
                placeholder="15"
                className={inputClasses}
              />
            </div>
          </div>
        </SectionCard>

        {/* API Keys */}
        <SectionCard
          id="api"
          icon={Key}
          title="API Keys"
          expanded={expandedSections.api}
          onToggle={() => toggleSection('api')}
          description="External service credentials"
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-zinc-400">Active Google API Key</label>
              <select
                value={activeGoogleApiKeyId}
                onChange={(e) => setActiveGoogleApiKey(e.target.value)}
                className={inputClasses}
                disabled={googleApiKeys.length === 0}
              >
                {googleApiKeys.length === 0 && <option value="">No keys configured</option>}
                {googleApiKeys.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label || 'Untitled Key'}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              {googleApiKeys.map((item, index) => {
                const isActive = item.id === activeGoogleApiKeyId
                return (
                  <div
                    key={item.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-zinc-500">Google Key #{index + 1}</p>
                      <div className="flex items-center gap-2">
                        {isActive && (
                          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                            Active
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => updateGoogleApiKeys((prev) => prev.filter((entry) => entry.id !== item.id))}
                          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                          title="Remove key"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        value={item.label}
                        onChange={(e) => updateGoogleApiKeys((prev) =>
                          prev.map((entry) => entry.id === item.id ? { ...entry, label: e.target.value } : entry)
                        )}
                        placeholder="Label (e.g., Production Key 1)"
                        className={inputClasses}
                      />
                      <input
                        type="password"
                        value={item.key}
                        onChange={(e) => updateGoogleApiKeys((prev) =>
                          prev.map((entry) => entry.id === item.id ? { ...entry, key: e.target.value } : entry)
                        )}
                        autoComplete="off"
                        placeholder="Enter Google API key"
                        className={inputClasses}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => updateGoogleApiKeys((prev) => ([
                ...prev,
                {
                  id: createGoogleApiKeyId(),
                  label: `Key ${prev.length + 1}`,
                  key: '',
                },
              ]))}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              <Plus className="h-4 w-4" />
              Add Google API Key
            </button>

            <p className="text-xs text-zinc-500">
              Used for Gemini image generation and Veo video generation across all products in this project.
            </p>
          </div>
        </SectionCard>

        {/* Save Button */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saved && (
            <span className="flex items-center gap-1.5 text-emerald-400 text-sm">
              <CheckCircle className="h-4 w-4" />
              Settings saved
            </span>
          )}
        </div>

        {/* Danger Zone */}
        <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
            <div>
              <h2 className="font-medium text-red-400">Danger Zone</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Delete this project and all its products, images, and settings permanently.
              </p>
            </div>
            <button
              onClick={async () => {
                if (!window.confirm(`Delete "${currentProject.name}"? This cannot be undone.`)) return
                setDeleting(true)
                try {
                  await deleteProject(projectId)
                  router.push('/')
                } finally {
                  setDeleting(false)
                }
              }}
              disabled={deleting}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/50 disabled:opacity-50 shrink-0"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete Project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
