'use client'

import { use, useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAppStore } from '@/lib/store'
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
} from 'lucide-react'

const navItems = [
  { label: 'Dashboard', href: '', icon: LayoutDashboard },
  { label: 'References', href: '/references', icon: Images },
  { label: 'Settings', href: '/settings', icon: Settings },
  { label: 'Prompts', href: '/prompts', icon: FileText },
  { label: 'Generate', href: '/generate', icon: Sparkles },
  { label: 'Gallery', href: '/gallery', icon: GalleryHorizontalEnd },
  { label: 'Storyboard', href: '/storyboard', icon: Film },
]

export default function ProductLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const pathname = usePathname()
  const { currentProduct, fetchProduct, updateProduct } = useAppStore()
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const handleNameSave = async () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== currentProduct?.name) {
      await updateProduct(id, { name: trimmed })
    }
    setEditingName(false)
  }

  useEffect(() => {
    fetchProduct(id)
  }, [id, fetchProduct])

  const basePath = `/products/${id}`

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r border-zinc-800 bg-zinc-900/50">
        <div className="border-b border-zinc-800 p-4">
          <Link
            href="/"
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Products
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
          {navItems.map((item) => {
            const href = `${basePath}${item.href}`
            const isActive =
              item.href === ''
                ? pathname === basePath
                : pathname.startsWith(href)

            return (
              <Link
                key={item.label}
                href={href}
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
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6">
        <GlobalGenerationQueue productId={id} />
        {children}
      </main>
    </div>
  )
}
