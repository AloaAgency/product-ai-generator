'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { Save, CheckCircle, Settings, Camera, Palette, Trash2, ArrowLeft, Key, ChevronDown } from 'lucide-react'
import type { GlobalStyleSettings } from '@/lib/types'

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
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    style: true,
    output: true,
    api: true,
  })

  useEffect(() => {
    fetchProject(projectId)
  }, [projectId, fetchProject])

  useEffect(() => {
    if (currentProject) {
      setName(currentProject.name)
      setDescription(currentProject.description || '')
      setSettings(currentProject.global_style_settings || {})
    }
  }, [currentProject])

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const updateField = (key: keyof GlobalStyleSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value || undefined }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateProject(projectId, {
        name,
        description: description || undefined,
        global_style_settings: settings,
      })
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

  const SectionCard = ({
    id,
    icon: Icon,
    title,
    description,
    children,
  }: {
    id: string
    icon: React.ComponentType<{ className?: string }>
    title: string
    description?: string
    children: React.ReactNode
  }) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <button
        onClick={() => toggleSection(id)}
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
            expandedSections[id] ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expandedSections[id] && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  )

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
                value={settings.default_variation_count ?? ''}
                onChange={(e) => {
                  const val = e.target.value ? parseInt(e.target.value, 10) : undefined
                  setSettings((prev) => ({ ...prev, default_variation_count: val }))
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
          description="External service credentials"
        >
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-400">Gemini API Key</label>
            <input
              type="password"
              value={(settings.gemini_api_key as string) || ''}
              onChange={(e) => updateField('gemini_api_key', e.target.value)}
              autoComplete="off"
              placeholder="Enter your Gemini API key"
              className={inputClasses}
            />
            <p className="text-xs text-zinc-500 mt-1.5">
              Used for Gemini image generation and Veo video generation across all products.
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
