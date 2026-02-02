'use client'

import { use, useEffect, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { PromptTemplate } from '@/lib/types'
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Loader2,
  FileText,
  Upload,
  Download,
  Image as ImageIcon,
  Video,
} from 'lucide-react'

export default function PromptsPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { id } = use(params)
  const {
    promptTemplates,
    fetchPromptTemplates,
    createPromptTemplate,
    updatePromptTemplate,
    deletePromptTemplate,
  } = useAppStore()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newText, setNewText] = useState('')
  const [newTags, setNewTags] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editText, setEditText] = useState('')
  const [editTags, setEditTags] = useState('')
  const [saving, setSaving] = useState(false)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const [batchUploading, setBatchUploading] = useState(false)
  const [batchResult, setBatchResult] = useState<{ total: number; created: number } | null>(null)
  const [promptTypeFilter, setPromptTypeFilter] = useState<'all' | 'image' | 'video'>('all')
  const [newPromptType, setNewPromptType] = useState<'image' | 'video'>('image')

  useEffect(() => {
    fetchPromptTemplates(id)
  }, [id, fetchPromptTemplates])

  function parseBatchMarkdown(content: string): { name: string; prompt_text: string; tags?: string[] }[] {
    // Strip leading comment lines (lines starting with #)
    const lines = content.split('\n')
    const strippedLines: string[] = []
    let pastHeader = false
    for (const line of lines) {
      if (!pastHeader && line.trimStart().startsWith('#')) continue
      pastHeader = true
      strippedLines.push(line)
    }

    const blocks = strippedLines.join('\n').split(/^---$/m).map((b) => b.trim()).filter(Boolean)
    return blocks.map((block) => {
      const blockLines = block.split('\n')
      const name = blockLines[0].trim()
      let tags: string[] | undefined
      let textStart = 1

      if (blockLines.length > 1 && /^tags:\s*/i.test(blockLines[1])) {
        tags = blockLines[1]
          .replace(/^tags:\s*/i, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        textStart = 2
      }

      const prompt_text = blockLines.slice(textStart).join('\n').trim()
      return { name, prompt_text, ...(tags && tags.length > 0 ? { tags } : {}) }
    }).filter((p) => p.name && p.prompt_text)
  }

  const handleBatchUpload = async (file: File) => {
    setBatchUploading(true)
    setBatchResult(null)
    try {
      const content = await file.text()
      const prompts = parseBatchMarkdown(content)
      let created = 0
      for (const p of prompts) {
        await createPromptTemplate(id, p)
        created++
      }
      setBatchResult({ total: prompts.length, created })
    } finally {
      setBatchUploading(false)
    }
  }

  const handleCreate = async () => {
    if (!newName.trim() || !newText.trim()) return
    setCreating(true)
    try {
      const tags = newTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      await createPromptTemplate(id, {
        name: newName.trim(),
        prompt_text: newText.trim(),
        tags: tags.length > 0 ? tags : undefined,
        prompt_type: newPromptType,
      })
      setNewName('')
      setNewText('')
      setNewTags('')
      setShowCreate(false)
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (t: PromptTemplate) => {
    setEditingId(t.id)
    setEditName(t.name)
    setEditText(t.prompt_text)
    setEditTags(t.tags?.join(', ') ?? '')
  }

  const handleSave = async () => {
    if (!editingId || !editName.trim() || !editText.trim()) return
    setSaving(true)
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      await updatePromptTemplate(id, editingId, {
        name: editName.trim(),
        prompt_text: editText.trim(),
        tags,
      })
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (promptId: string) => {
    setDeletingId(promptId)
    try {
      await deletePromptTemplate(id, promptId)
      setConfirmDeleteId(null)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Prompt Templates</h1>
        <div className="flex items-center gap-2">
          <label
            className={`inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium cursor-pointer hover:bg-zinc-700 transition-colors ${batchUploading ? 'opacity-40 pointer-events-none' : ''}`}
          >
            {batchUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Batch Upload
            <input
              type="file"
              accept=".md,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleBatchUpload(file)
                e.target.value = ''
              }}
            />
          </label>
          <a
            href="/sample-prompts.md"
            download
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <Download className="h-4 w-4" />
            Sample
          </a>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Template
          </button>
        </div>
      </div>

      {/* Prompt type filter */}
      <div className="flex items-center gap-1.5">
        {([
          { label: 'All', value: 'all' as const },
          { label: 'Image', value: 'image' as const, icon: ImageIcon },
          { label: 'Video', value: 'video' as const, icon: Video },
        ]).map((f) => (
          <button
            key={f.value}
            onClick={() => setPromptTypeFilter(f.value)}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              promptTypeFilter === f.value
                ? 'bg-zinc-100 text-zinc-900'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {f.icon && <f.icon className="h-3.5 w-3.5" />}
            {f.label}
          </button>
        ))}
      </div>

      {/* Batch upload result */}
      {batchResult && (
        <div className="flex items-center justify-between rounded-lg border border-green-800 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          <span>Imported {batchResult.created} of {batchResult.total} templates.</span>
          <button onClick={() => setBatchResult(null)} className="text-green-500 hover:text-green-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-300">Create Template</h2>
            <div className="flex items-center gap-1 rounded-lg border border-zinc-700 p-0.5">
              <button
                onClick={() => setNewPromptType('image')}
                className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  newPromptType === 'image' ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <ImageIcon className="h-3 w-3" /> Image
              </button>
              <button
                onClick={() => setNewPromptType('video')}
                className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  newPromptType === 'video' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Video className="h-3 w-3" /> Video
              </button>
            </div>
          </div>
          <input
            type="text"
            placeholder="Template name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <textarea
            rows={4}
            placeholder="Prompt text..."
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
          />
          <input
            type="text"
            placeholder="Tags (comma-separated, optional)"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim() || !newText.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Create
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Template List */}
      {(() => {
        const filtered = promptTypeFilter === 'all'
          ? promptTemplates
          : promptTemplates.filter((t) => (t.prompt_type || 'image') === promptTypeFilter)
        return filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-800/20 py-16 text-zinc-500">
          <FileText className="h-10 w-10 mb-3" />
          <p className="text-sm">No prompt templates yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-4 space-y-3"
            >
              {editingId === t.id ? (
                /* Edit mode */
                <div className="space-y-3">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                  />
                  <textarea
                    rows={4}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none resize-none"
                  />
                  <input
                    type="text"
                    placeholder="Tags (comma-separated)"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving || !editName.trim() || !editText.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-zinc-100 truncate">
                        {t.name}
                      </h3>
                      <p className="mt-1 text-xs text-zinc-400 line-clamp-2">
                        {t.prompt_text}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(t)}
                        className="rounded p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {confirmDeleteId === t.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(t.id)}
                            disabled={deletingId === t.id}
                            className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 transition-colors"
                          >
                            {deletingId === t.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              'Confirm'
                            )}
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
                          onClick={() => setConfirmDeleteId(t.id)}
                          className="rounded p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-700 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      t.prompt_type === 'video'
                        ? 'bg-purple-600/20 text-purple-400'
                        : 'bg-zinc-700/60 text-zinc-400'
                    }`}>
                      {t.prompt_type === 'video' ? 'Video' : 'Image'}
                    </span>
                    {t.tags && t.tags.length > 0 && t.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-zinc-700/60 px-2.5 py-0.5 text-xs text-zinc-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )
      })()}
    </div>
  )
}
