'use client'

import { use, useEffect, useState, useRef, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import GlobalGenerationQueue from '@/components/GlobalGenerationQueue'
import {
  ArrowLeft,
  LayoutDashboard,
  Images,
  Settings,
  Sparkles,
  GalleryHorizontalEnd,
  FileText,
  Film,
  Clapperboard,
  Menu,
  Wand2,
} from 'lucide-react'

const navItems = [
  { label: 'Dashboard', href: '', icon: LayoutDashboard },
  { label: 'References', href: '/references', icon: Images },
  { label: 'Settings', href: '/settings', icon: Settings },
  { label: 'Prompts', href: '/prompts', icon: FileText },
  { label: 'Generate', href: '/generate', icon: Sparkles },
  { label: 'Gallery', href: '/gallery', icon: GalleryHorizontalEnd },
  { label: 'Fix Image', href: '/fix-image', icon: Wand2 },
  { label: 'Storyboard', href: '/storyboard', icon: Film },
  { label: 'Scenes', href: '/scenes', icon: Clapperboard },
]

export default function ProductLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id } = use(params)
  const pathname = usePathname()
  const { currentProduct, currentProject, fetchProduct, fetchProject, updateProduct } = useAppStore()
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useModalShortcuts({
    isOpen: sidebarOpen,
    onClose: () => setSidebarOpen(false),
  })

  const handleNameSave = async () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== currentProduct?.name) {
      await updateProduct(id, { name: trimmed })
    }
    setEditingName(false)
  }

  useEffect(() => {
    fetchProduct(id)
    fetchProject(projectId)
  }, [id, projectId, fetchProduct, fetchProject])

  const basePath = `/projects/${projectId}/products/${id}`

  const renderNavLinks = useCallback((onLinkClick?: () => void) => (
    navItems.map((item) => {
      const href = `${basePath}${item.href}`
      const isActive =
        item.href === ''
          ? pathname === basePath
          : pathname.startsWith(href)

      return (
        <Link
          key={item.label}
          href={href}
          onClick={onLinkClick}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            isActive
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
          }`}
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </Link>
      )
    })
  ), [basePath, pathname])

  return (
    <div className="flex min-h-screen">
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-30 flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur px-4 py-3 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-500">
            {currentProject?.name ?? 'Project'}
          </p>
          <p className="truncate text-sm font-semibold text-zinc-100">
            {currentProduct?.name ?? 'Loading...'}
          </p>
        </div>
      </div>

      {/* Mobile drawer overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        >
          <aside
            className="flex h-full w-72 max-w-[80vw] flex-col border-r border-zinc-800 bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-800 p-4">
              <Link
                href={`/projects/${projectId}`}
                className="mb-1 inline-flex items-center gap-1.5 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
              >
                <ArrowLeft className="h-3 w-3" />
                {currentProject?.name ?? 'Project'}
              </Link>
              <h2 className="truncate text-sm font-semibold text-zinc-100">
                {currentProduct?.name ?? 'Loading...'}
              </h2>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3">
              {renderNavLinks(() => setSidebarOpen(false))}
            </nav>
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 flex-col border-r border-zinc-800 bg-zinc-900/50">
        <div className="border-b border-zinc-800 p-4">
          <Link
            href={`/projects/${projectId}`}
            className="mb-1 inline-flex items-center gap-1.5 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
          >
            <ArrowLeft className="h-3 w-3" />
            {currentProject?.name ?? 'Project'}
          </Link>
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
              className="w-full truncate rounded bg-zinc-800 px-1 py-0.5 text-sm font-semibold text-zinc-100 outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          ) : (
            <h2
              className="truncate text-sm font-semibold text-zinc-100 cursor-pointer hover:text-blue-400 transition-colors"
              onClick={() => {
                setNameValue(currentProduct?.name ?? '')
                setEditingName(true)
              }}
              title="Click to edit"
            >
              {currentProduct?.name ?? 'Loading...'}
            </h2>
          )}
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {renderNavLinks()}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6 pt-16 md:pt-6">
        <GlobalGenerationQueue productId={id} />
        {children}
      </main>
    </div>
  )
}
