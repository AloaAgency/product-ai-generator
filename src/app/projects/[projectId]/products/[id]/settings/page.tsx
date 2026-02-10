'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { Save, CheckCircle, Settings, Camera, Palette, Trash2, FolderOpen, Plus, Download, Upload, ChevronDown, FileText } from 'lucide-react'
import type { GlobalStyleSettings, SettingsTemplate } from '@/lib/types'

function parseTemplateMarkdown(text: string): { name: string; settings: GlobalStyleSettings } | null {
  // Try to extract JSON from a ```json code block
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/)
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim())
      if (parsed.settings && typeof parsed.settings === 'object') {
        return { name: parsed.name || 'Imported Template', settings: parsed.settings }
      }
      // If the JSON itself is the settings object (no wrapper)
      if (parsed.subject_rule || parsed.lens || parsed.style || parsed.lighting) {
        return { name: 'Imported Template', settings: parsed }
      }
    } catch {
      // fall through
    }
  }
  // Try parsing the whole text as JSON
  try {
    const parsed = JSON.parse(text.trim())
    if (parsed.settings && typeof parsed.settings === 'object') {
      return { name: parsed.name || 'Imported Template', settings: parsed.settings }
    }
    if (parsed.subject_rule || parsed.lens || parsed.style || parsed.lighting) {
      return { name: 'Imported Template', settings: parsed }
    }
  } catch {
    // not JSON
  }
  return null
}

export default function ProductSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id } = use(params)
  const router = useRouter()
  const {
    currentProduct, projects, fetchProduct, fetchProjects, updateProduct, deleteProduct,
    settingsTemplates, fetchSettingsTemplates, createSettingsTemplate, updateSettingsTemplate,
    deleteSettingsTemplate, activateSettingsTemplate,
  } = useAppStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState(projectId)
  const [settings, setSettings] = useState<GlobalStyleSettings>({})
  const [defaultVariationInput, setDefaultVariationInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    templates: true,
    style: true,
    output: true,
  })

  useEffect(() => {
    fetchProduct(id)
    fetchProjects()
    fetchSettingsTemplates(id)
  }, [id, fetchProduct, fetchProjects, fetchSettingsTemplates])

  useEffect(() => {
    if (currentProduct) {
      setName(currentProduct.name)
      setDescription(currentProduct.description || '')
      setSettings(currentProduct.global_style_settings || {})
      const defaults = currentProduct.global_style_settings || {}
      setDefaultVariationInput(
        typeof defaults.default_variation_count === 'number'
          ? String(defaults.default_variation_count)
          : ''
      )
    }
  }, [currentProduct])

  const activeTemplate = settingsTemplates.find((t) => t.is_active)

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
      const updates: Parameters<typeof updateProduct>[1] = {
        name,
        description: description || undefined,
        global_style_settings: settings,
      }
      if (selectedProjectId !== projectId) {
        updates.project_id = selectedProjectId
      }
      await updateProduct(id, updates)
      if (activeTemplate) {
        await updateSettingsTemplate(id, activeTemplate.id, { settings: settings })
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      if (selectedProjectId !== projectId) {
        router.push(`/projects/${selectedProjectId}/products/${id}/settings`)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAsTemplate = async () => {
    if (!templateName.trim()) return
    await createSettingsTemplate(id, { name: templateName.trim(), settings: settings })
    setTemplateName('')
    setShowNewTemplate(false)
    if (settingsTemplates.length === 0) {
      await fetchSettingsTemplates(id)
    }
  }

  const handleSelectTemplate = async (templateId: string) => {
    const tmpl = settingsTemplates.find((t) => t.id === templateId)
    if (!tmpl) return
    await activateSettingsTemplate(id, templateId)
    setSettings((prev) => ({
      ...tmpl.settings,
      gemini_api_key: prev.gemini_api_key,
      google_api_keys: prev.google_api_keys,
      active_google_api_key_id: prev.active_google_api_key_id,
    }))
    const tmplValue = tmpl.settings?.default_variation_count
    setDefaultVariationInput(
      typeof tmplValue === 'number'
        ? String(tmplValue)
        : ''
    )
  }

  const parseVariationValue = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    return Math.min(50, Math.max(1, parsed))
  }

  const handleDeleteTemplate = async (tmpl: SettingsTemplate) => {
    if (!window.confirm(`Delete template "${tmpl.name}"?`)) return
    await deleteSettingsTemplate(id, tmpl.id)
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportError('')
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const result = parseTemplateMarkdown(text)
      if (!result) {
        setImportError('Could not find valid template JSON in the file. Use the sample format as a guide.')
        return
      }
      await createSettingsTemplate(id, { name: result.name, settings: result.settings })
      await fetchSettingsTemplates(id)
    } catch {
      setImportError('Failed to import template file.')
    }
    // Reset input so re-uploading the same file triggers onChange
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDownloadSample = () => {
    const md = `# Settings Template Format

Use this format to generate a settings template via LLM. Save as \`.md\` or \`.json\` and import it on the Settings page.

\`\`\`json
{
  "name": "My Template Name",
  "settings": {
    "subject_rule": "Always center the product with clean negative space",
    "lens": "85mm f/1.4",
    "camera_height": "Eye level",
    "color_grading": "Warm tones, slight orange teal split",
    "lighting": "Soft key light with rim accent",
    "style": "Cinematic product photography",
    "constraints": "No text overlays, no watermarks",
    "reference_rule": "Match reference image framing closely",
    "default_resolution": "4K",
    "default_aspect_ratio": "16:9",
    "default_fidelity": "high",
    "custom_suffix": "",
    "default_variation_count": 15
  }
}
\`\`\`

## Field Descriptions

| Field | Description |
|-------|-------------|
| subject_rule | How the product subject should be framed/positioned |
| lens | Camera lens specification |
| camera_height | Camera angle/height |
| color_grading | Color treatment and grading style |
| lighting | Lighting setup description |
| style | Overall visual style |
| constraints | Things to avoid in generation |
| reference_rule | How reference images should be used |
| default_resolution | "2K" or "4K" |
| default_aspect_ratio | "16:9", "1:1", or "9:16" |
| default_fidelity | Fidelity level string |
| custom_suffix | Text appended to every prompt |
| default_variation_count | Number of variations per generation (1-50) |
`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'settings-template-format.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!currentProduct) {
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

  const selectField = (label: string, key: keyof GlobalStyleSettings, options: string[]) => (
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
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Settings className="h-5 w-5 sm:h-6 sm:w-6 text-zinc-500" />
            Product Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Configure style settings and generation defaults
          </p>
        </div>

        {/* Product Info Card */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-400">Product Name</label>
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
              placeholder="Brief description of this product..."
              className={`${inputClasses} resize-y`}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-400">
              <span className="inline-flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5" />
                Project
              </span>
            </label>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className={inputClasses}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {selectedProjectId !== projectId && (
              <p className="text-xs text-amber-400">Saving will move this product to a different project.</p>
            )}
          </div>
        </div>

        {/* Settings Templates */}
        <SectionCard
          id="templates"
          icon={FileText}
          title="Settings Template"
          description="Save and load preset configurations"
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeTemplate?.id ?? ''}
              onChange={(e) => { if (e.target.value) handleSelectTemplate(e.target.value) }}
              className={`${inputClasses} flex-1 min-w-[180px]`}
            >
              {settingsTemplates.length === 0 && <option value="">No templates yet</option>}
              {!activeTemplate && settingsTemplates.length > 0 && <option value="">(unsaved)</option>}
              {settingsTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>

            <button
              onClick={() => setShowNewTemplate(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Save As</span>
            </button>

            {activeTemplate && (
              <button
                onClick={() => handleDeleteTemplate(activeTemplate)}
                title="Delete template"
                className="inline-flex items-center justify-center rounded-lg border border-red-900/50 bg-red-950/30 p-2.5 text-red-400 transition-colors hover:bg-red-900/40 shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}

            <button
              onClick={handleDownloadSample}
              title="Download sample format"
              className="inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-300 shrink-0"
            >
              <Download className="h-4 w-4" />
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              title="Import template from .md or .json"
              className="inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-300 shrink-0"
            >
              <Upload className="h-4 w-4" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.json,.txt"
              onChange={handleImportFile}
              className="hidden"
            />
          </div>

          {importError && (
            <p className="text-sm text-red-400">{importError}</p>
          )}

          {showNewTemplate && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2">
              <input
                type="text"
                placeholder="Template name..."
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAsTemplate() }}
                autoFocus
                className={`${inputClasses} flex-1`}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveAsTemplate}
                  disabled={!templateName.trim()}
                  className="flex-1 sm:flex-none rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-50 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => { setShowNewTemplate(false); setTemplateName('') }}
                  className="flex-1 sm:flex-none rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </SectionCard>

        {/* Style Settings */}
        <SectionCard
          id="style"
          icon={Palette}
          title="Style Settings"
          description="Photography and visual style configuration"
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
            {selectField('Resolution', 'default_resolution', ['2K', '4K'])}
            {selectField('Aspect Ratio', 'default_aspect_ratio', ['16:9', '1:1', '9:16'])}
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
                Permanently delete this product and all associated data.
              </p>
            </div>
            <button
              onClick={async () => {
                if (!window.confirm(`Delete "${currentProduct.name}"? This cannot be undone.`)) return
                setDeleting(true)
                try {
                  await deleteProduct(id)
                  router.push(`/projects/${projectId}`)
                } finally {
                  setDeleting(false)
                }
              }}
              disabled={deleting}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/50 disabled:opacity-50 shrink-0"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete Product'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
