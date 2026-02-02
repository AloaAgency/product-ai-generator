'use client'

import { use, useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { Plus, Package, X, ArrowLeft, Trash2 } from 'lucide-react'

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = use(params)
  const router = useRouter()
  const {
    currentProject,
    products,
    loadingProducts,
    fetchProject,
    fetchProducts,
    createProduct,
    updateProject,
    deleteProject,
  } = useAppStore()
  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [deleting, setDeleting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const handleNameSave = async () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== currentProject?.name) {
      await updateProject(projectId, { name: trimmed })
    }
    setEditingName(false)
  }

  useEffect(() => {
    fetchProject(projectId)
    fetchProducts(projectId)
  }, [projectId, fetchProject, fetchProducts])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      await createProduct({
        name: name.trim(),
        description: description.trim() || undefined,
        project_id: projectId,
      })
      setName('')
      setDescription('')
      setShowModal(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <Link
              href="/"
              className="mb-1 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Projects
            </Link>
            <div className="flex items-center gap-3">
              {editingName ? (
                <input
                  ref={nameInputRef}
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={handleNameSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNameSave()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                  className="rounded bg-zinc-800 px-2 py-1 text-xl font-semibold tracking-tight text-zinc-100 outline-none focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              ) : (
                <h1
                  className="cursor-pointer text-xl font-semibold tracking-tight transition-colors hover:text-blue-400"
                  onClick={() => {
                    setNameValue(currentProject?.name ?? '')
                    setEditingName(true)
                  }}
                  title="Click to edit"
                >
                  {currentProject?.name ?? 'Loading...'}
                </h1>
              )}
              <Link
                href={`/projects/${projectId}/settings`}
                className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
              >
                Settings
              </Link>
            </div>
            {currentProject?.description && (
              <p className="mt-1 text-sm text-zinc-500">{currentProject.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!currentProject) return
                if (!window.confirm(`Delete "${currentProject.name}" and all its products? This cannot be undone.`)) return
                setDeleting(true)
                try {
                  await deleteProject(projectId)
                  router.push('/')
                } finally {
                  setDeleting(false)
                }
              }}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button
              onClick={() => setShowModal(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              New Product
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {loadingProducts ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 rounded-full bg-zinc-800 p-4">
              <Package className="h-8 w-8 text-zinc-500" />
            </div>
            <h2 className="mb-2 text-lg font-medium text-zinc-300">No products yet</h2>
            <p className="mb-6 max-w-sm text-sm text-zinc-500">
              Create your first product in this project to start generating AI images.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              New Product
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <Link
                key={product.id}
                href={`/projects/${projectId}/products/${product.id}`}
                className="group rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60"
              >
                <h3 className="mb-1 font-medium text-zinc-100 group-hover:text-white">
                  {product.name}
                </h3>
                {product.description && (
                  <p className="mb-3 line-clamp-2 text-sm text-zinc-500">
                    {product.description}
                  </p>
                )}
                <p className="text-xs text-zinc-600">
                  Created {new Date(product.created_at).toLocaleDateString()}
                </p>
              </Link>
            ))}
          </div>
        )}
      </main>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold">New Product</h2>
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
                  placeholder="e.g. Running Shoes Pro"
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
                  placeholder="Brief description of the product..."
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
                  {creating ? 'Creating...' : 'Create Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
