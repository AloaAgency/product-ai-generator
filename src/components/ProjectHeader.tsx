'use client'

import { useState, useRef, useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getSafeErrorMessage } from './errorDisplay.helpers'

interface ProjectHeaderProps {
  projectId: string
  projectName: string | undefined
  projectDescription?: string | null
  onNameSave: (name: string) => Promise<void>
  actions?: ReactNode
}

export function ProjectHeader({
  projectId,
  projectName,
  projectDescription,
  onNameSave,
  actions,
}: ProjectHeaderProps) {
  const pathname = usePathname()
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const isGallery = pathname.endsWith('/gallery')

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus()
    }
  }, [editingName])

  const handleNameSave = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed) {
      setNameError('Project name is required.')
      return
    }
    try {
      if (trimmed !== projectName) {
        await onNameSave(trimmed)
      }
      setNameError(null)
      setEditingName(false)
    } catch (error) {
      setNameError(
        getSafeErrorMessage(
          error instanceof Error ? error.message : null,
          'Failed to save project name. Please try again.'
        )
      )
    }
  }

  const handleStartEditing = () => {
    setNameValue(projectName ?? '')
    setNameError(null)
    setEditingName(true)
  }

  const handleCancelEditing = () => {
    setNameValue(projectName ?? '')
    setNameError(null)
    setEditingName(false)
  }

  const tabs = [
    { label: 'Products', href: `/projects/${projectId}` },
    { label: 'Gallery', href: `/projects/${projectId}/gallery` },
  ]

  return (
    <header className="border-b border-zinc-800">
      <div className="px-4 sm:px-6 py-3 sm:py-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                <div>
                  <label htmlFor="project-name-input" className="sr-only">Project name</label>
                  <input
                    id="project-name-input"
                    ref={nameInputRef}
                    value={nameValue}
                    onChange={(e) => {
                      setNameValue(e.target.value)
                      if (nameError) setNameError(null)
                    }}
                    onBlur={() => void handleNameSave()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleNameSave()
                      if (e.key === 'Escape') handleCancelEditing()
                    }}
                    className="rounded bg-zinc-800 px-2 py-1 text-xl font-semibold tracking-tight text-zinc-100 outline-none focus:ring-1 focus:ring-blue-500"
                    aria-invalid={nameError ? 'true' : 'false'}
                    aria-describedby={nameError ? 'project-name-error' : undefined}
                    autoFocus
                  />
                  {nameError && (
                    <p id="project-name-error" className="mt-1 text-xs text-red-400">
                      {nameError}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer text-left text-xl font-semibold tracking-tight transition-colors hover:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                  onClick={handleStartEditing}
                  title="Click to edit"
                  aria-label={`Edit project name${projectName ? `: ${projectName}` : ''}`}
                >
                  <span className="text-xl font-semibold tracking-tight">
                    {projectName ?? 'Loading...'}
                  </span>
                </button>
              )}
              <Link
                href={`/projects/${projectId}/settings`}
                className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
              >
                Settings
              </Link>
            </div>
            {projectDescription && (
              <p className="mt-1 text-sm text-zinc-500">{projectDescription}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <nav className="flex gap-0">
          {tabs.map((tab) => {
            const isActive =
              tab.href === `/projects/${projectId}`
                ? !isGallery
                : isGallery
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {tab.label}
                {isActive && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-zinc-100" />
                )}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
