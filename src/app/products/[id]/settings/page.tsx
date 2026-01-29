'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { Save, CheckCircle, Settings, Camera, Palette, Trash2 } from 'lucide-react'
import type { GlobalStyleSettings } from '@/lib/types'

export default function ProductSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const { currentProduct, fetchProduct, updateProduct, deleteProduct } = useAppStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [settings, setSettings] = useState<GlobalStyleSettings>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    fetchProduct(id)
  }, [id, fetchProduct])

  useEffect(() => {
    if (currentProduct) {
      setName(currentProduct.name)
      setDescription(currentProduct.description || '')
      setSettings(currentProduct.global_style_settings || {})
    }
  }, [currentProduct])

  const updateField = (key: keyof GlobalStyleSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value || undefined }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateProduct(id, {
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

  if (!currentProduct) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400">
        Loading...
      </div>
    )
  }

  const textInput = (label: string, key: keyof GlobalStyleSettings) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">
        {label}
      </label>
      <input
        type="text"
        value={settings[key] || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  )

  const textArea = (label: string, key: keyof GlobalStyleSettings) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">
        {label}
      </label>
      <textarea
        rows={3}
        value={settings[key] || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
      />
    </div>
  )

  const dropdown = (
    label: string,
    key: keyof GlobalStyleSettings,
    options: string[]
  ) => (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">
        {label}
      </label>
      <select
        value={settings[key] || ''}
        onChange={(e) => updateField(key, e.target.value)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">Not set</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6 max-w-3xl mx-auto space-y-8">
      {/* Product Info */}
      <div className="space-y-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6 text-zinc-400" />
          Product Settings
        </h1>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">
            Product Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">
            Description
          </label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
          />
        </div>
      </div>

      <hr className="border-zinc-800" />

      {/* Style Settings */}
      <div className="space-y-6">
        <h2 className="text-xl font-semibold flex items-center gap-2">
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

        <h2 className="text-xl font-semibold flex items-center gap-2 pt-2">
          <Camera className="w-5 h-5 text-zinc-400" />
          Default Output Settings
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {dropdown('Default Resolution', 'default_resolution', ['2K', '4K'])}
          {dropdown('Default Aspect Ratio', 'default_aspect_ratio', [
            '16:9',
            '1:1',
            '9:16',
          ])}
          {textInput('Default Fidelity', 'default_fidelity')}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">
              Default Variations
            </label>
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
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pt-4">
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
            Settings saved successfully
          </span>
        )}
      </div>

      <hr className="border-zinc-800" />

      {/* Danger Zone */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-red-400">Danger Zone</h2>
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 flex items-center justify-between">
          <div>
            <p className="font-medium text-zinc-100">Delete this product</p>
            <p className="text-sm text-zinc-400">
              This action cannot be undone. All images and settings will be permanently deleted.
            </p>
          </div>
          <button
            onClick={async () => {
              if (!window.confirm(`Delete "${currentProduct.name}"? This cannot be undone.`)) return
              setDeleting(true)
              try {
                await deleteProduct(id)
                router.push('/')
              } finally {
                setDeleting(false)
              }
            }}
            disabled={deleting}
            className="flex items-center gap-2 rounded-lg border border-red-700 bg-red-900/30 px-4 py-2 font-medium text-red-400 hover:bg-red-900/60 disabled:opacity-50 transition-colors shrink-0 ml-4"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete Product'}
          </button>
        </div>
      </div>
    </div>
  )
}
