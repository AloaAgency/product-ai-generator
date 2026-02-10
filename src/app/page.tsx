'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import { Plus, FolderOpen, X, Pencil, Trash2, Check } from 'lucide-react'

export default function Home() {
  const { projects, loadingProjects, fetchProjects, createProject, updateProject, deleteProject } = useAppStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleSubmitModal = useCallback(() => {
    if (name.trim() && !creating) {
      const fakeEvent = { preventDefault: () => {} } as React.FormEvent
      handleCreate(fakeEvent)
    }
  }, [name, creating])

  useModalShortcuts({
    isOpen: showModal,
    onClose: () => setShowModal(false),
    onSubmit: handleSubmitModal,
  })

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      await createProject({ name: name.trim(), description: description.trim() || undefined })
      setName('')
      setDescription('')
      setShowModal(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Aloa AI Product Imager</h1>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {loadingProjects ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 rounded-full bg-zinc-800 p-4">
              <FolderOpen className="h-8 w-8 text-zinc-500" />
            </div>
            <h2 className="mb-2 text-lg font-medium text-zinc-300">No projects yet</h2>
            <p className="mb-6 max-w-sm text-sm text-zinc-500">
              Create your first project to organize products and start generating AI images.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              New Project
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60"
              >
                <Link href={`/projects/${project.id}`} className="block">
                  {editingId === project.id ? (
                    <div
                      className="mb-1 flex items-center gap-2"
                      onClick={(e) => e.preventDefault()}
                    >
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            if (editName.trim()) {
                              await updateProject(project.id, { name: editName.trim() })
                            }
                            setEditingId(null)
                          }
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm font-medium text-zinc-100 outline-none focus:ring-1 focus:ring-blue-500"
                        autoFocus
                      />
                      <button
                        onClick={async (e) => {
                          e.preventDefault()
                          if (editName.trim()) {
                            await updateProject(project.id, { name: editName.trim() })
                          }
                          setEditingId(null)
                        }}
                        className="rounded p-1 text-zinc-400 hover:text-green-400"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <h3 className="mb-1 font-medium text-zinc-100 group-hover:text-white">
                      {project.name}
                    </h3>
                  )}
                  {project.description && (
                    <p className="mb-3 line-clamp-2 text-sm text-zinc-500">
                      {project.description}
                    </p>
                  )}
                  <p className="text-xs text-zinc-600">
                    Created {new Date(project.created_at).toLocaleDateString()}
                  </p>
                </Link>
                {editingId !== project.id && (
                  <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditName(project.name)
                        setEditingId(project.id)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                    >
                      <Pencil className="h-3 w-3" />
                      Rename
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!window.confirm(`Delete "${project.name}" and all its products?`)) return
                        await deleteProject(project.id)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold">New Project</h2>
              <button
                onClick={() => setShowModal(false)}
                className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-400">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Summer Collection 2026"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-400">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of the project..."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || creating}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
