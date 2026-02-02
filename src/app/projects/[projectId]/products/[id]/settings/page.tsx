'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { Save, CheckCircle, Settings, Camera, Palette, Trash2, FolderOpen, Plus, Download, Upload } from 'lucide-react'
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
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    }
  }, [currentProduct])

  const activeTemplate = settingsTemplates.find((t) => t.is_active)

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
        await updateSettingsTemplate(id, activeTemplate.id, { settings })
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
    await createSettingsTemplate(id, { name: templateName.trim(), settings })
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
    setSettings(tmpl.settings)
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
      <div className="flex items-center justify-center h-64 text-zinc-400">
        Loading...
      </div>
    )
  }

  const inputClasses = 'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const textInput = (label: string, key: keyof GlobalStyleSettings) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      <input
        type="text"
        value={settings[key] || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className={inputClasses}
      />
    </div>
  )

  const textArea = (label: string, key: keyof GlobalStyleSettings) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      <textarea
        rows={3}
        value={settings[key] || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className={`${inputClasses} resize-y`}
      />
    </div>
  )

  const selectField = (label: string, key: keyof GlobalStyleSettings, options: string[]) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      <select
        value={settings[key] || ''}
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

  const iconBtn = (onClick: () => void, title: string, icon: React.ReactNode, variant: 'default' | 'danger' = 'default') => (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center justify-center rounded-lg border px-2.5 py-2 transition-colors shrink-0 ${
        variant === 'danger'
          ? 'border-red-900/50 bg-red-950/20 text-red-400 hover:bg-red-900/30'
          : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 p-4 sm:p-6 max-w-3xl mx-auto space-y-6 sm:space-y-8">
      {/* Product Info */}
      <div className="space-y-4">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 sm:w-6 sm:h-6 text-zinc-400" />
          Product Settings
        </h1>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Product Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClasses} resize-y`} />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">
            <span className="inline-flex items-center gap-1.5">
              <FolderOpen className="h-4 w-4 text-zinc-400" />
              Project
            </span>
          </label>
          <select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)} className={inputClasses}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedProjectId !== projectId && (
            <p className="mt-1 text-xs text-amber-400">Saving will move this product to a different project.</p>
          )}
        </div>
      </div>

      <hr className="border-zinc-800" />

      {/* Settings Templates */}
      <div className="space-y-3">
        <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2">
          <Palette className="w-5 h-5 text-zinc-400" />
          Settings Template
        </h2>

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
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Save As</span>
          </button>

          {activeTemplate && iconBtn(
            () => handleDeleteTemplate(activeTemplate),
            'Delete template',
            <Trash2 className="w-4 h-4" />,
            'danger'
          )}

          {iconBtn(handleDownloadSample, 'Download sample format', <Download className="w-4 h-4" />)}

          {iconBtn(
            () => fileInputRef.current?.click(),
            'Import template from .md or .json',
            <Upload className="w-4 h-4" />
          )}

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
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
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
                className="flex-1 sm:flex-none rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => { setShowNewTemplate(false); setTemplateName('') }}
                className="flex-1 sm:flex-none rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Style Settings */}
      <div className="space-y-4 sm:space-y-6">
        <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2">
          <Palette className="w-5 h-5 text-zinc-400" />
          Style Settings
        </h2>

        <div className="space-y-4">
          {textArea('Subject Rule', 'subject_rule')}
          {textInput('Lens', 'lens')}
          {textInput('Camera Height', 'camera_height')}
          {textArea('Color Grading', 'color_grading')}
          {textInput('Lighting', 'lighting')}
          {textArea('Style', 'style')}
          {textArea('Constraints', 'constraints')}
          {textArea('Reference Rule', 'reference_rule')}
          {textArea('Custom Suffix', 'custom_suffix')}
        </div>

        <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 pt-2">
          <Camera className="w-5 h-5 text-zinc-400" />
          Default Output Settings
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {selectField('Resolution', 'default_resolution', ['2K', '4K'])}
          {selectField('Aspect Ratio', 'default_aspect_ratio', ['16:9', '1:1', '9:16'])}
          {textInput('Fidelity', 'default_fidelity')}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Variations</label>
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
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-green-400 text-sm">
            <CheckCircle className="w-4 h-4" />
            Saved
          </span>
        )}
      </div>

      <hr className="border-zinc-800" />

      {/* Danger Zone */}
      <div className="space-y-4">
        <h2 className="text-lg sm:text-xl font-semibold text-red-400">Danger Zone</h2>
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div>
            <p className="font-medium text-zinc-100">Delete this product</p>
            <p className="text-sm text-zinc-400">This action cannot be undone.</p>
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
            className="flex items-center justify-center gap-2 rounded-lg border border-red-700 bg-red-900/30 px-4 py-2 font-medium text-red-400 hover:bg-red-900/60 disabled:opacity-50 transition-colors shrink-0"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete Product'}
          </button>
        </div>
      </div>
    </div>
  )
}
