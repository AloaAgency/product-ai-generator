'use client'

import { use, useEffect } from 'react'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import {
  Images,
  FileText,
  Sparkles,
  Upload,
  PenLine,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react'

export default function ProductDashboard({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { projectId, id } = use(params)
  const {
    currentProduct,
    referenceSets,
    promptTemplates,
    generationJobs,
    galleryImages,
    loadingJobs,
    fetchReferenceSets,
    fetchPromptTemplates,
    fetchGenerationJobs,
    fetchGallery,
  } = useAppStore()

  useEffect(() => {
    fetchReferenceSets(id)
    fetchPromptTemplates(id)
    fetchGenerationJobs(id)
    fetchGallery(id)
  }, [id, fetchReferenceSets, fetchPromptTemplates, fetchGenerationJobs, fetchGallery])

  const basePath = `/projects/${projectId}/products/${id}`

  const stats = [
    { label: 'Reference Sets', value: referenceSets.length, icon: Images },
    { label: 'Prompts', value: promptTemplates.length, icon: FileText },
    { label: 'Generated Images', value: galleryImages.length, icon: Sparkles },
  ]

  const actions = [
    {
      label: 'Upload References',
      description: 'Add product reference images',
      href: `${basePath}/references`,
      icon: Upload,
    },
    {
      label: 'Create Prompt',
      description: 'Write a new prompt template',
      href: `${basePath}/settings`,
      icon: PenLine,
    },
    {
      label: 'Start Generating',
      description: 'Generate new product images',
      href: `${basePath}/generate`,
      icon: Play,
    },
  ]

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      case 'failed':
      case 'cancelled':
        return <XCircle className="h-4 w-4 text-red-500" />
      case 'running':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
      default:
        return <Clock className="h-4 w-4 text-zinc-500" />
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        {currentProduct?.description && (
          <p className="mt-1 text-sm text-zinc-500">{currentProduct.description}</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="mb-2 flex items-center gap-2 text-zinc-500">
              <stat.icon className="h-4 w-4" />
              <span className="text-sm">{stat.label}</span>
            </div>
            <p className="text-2xl font-semibold">{stat.value}</p>
          </div>
        ))}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Quick Actions</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {actions.map((action) => (
            <Link
              key={action.label}
              href={action.href}
              className="group flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60"
            >
              <div className="rounded-lg bg-zinc-800 p-2 transition-colors group-hover:bg-zinc-700">
                <action.icon className="h-4 w-4 text-zinc-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-200">{action.label}</p>
                <p className="text-xs text-zinc-500">{action.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Recent Generation Jobs</h2>
        {loadingJobs ? (
          <div className="flex justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
          </div>
        ) : generationJobs.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-10 text-center">
            <p className="text-sm text-zinc-500">No generation jobs yet. Start generating to see them here.</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
            {generationJobs.slice(0, 5).map((job) => {
              const unitLabel = job.job_type === 'video'
                ? (job.variation_count === 1 ? 'video' : 'videos')
                : (job.variation_count === 1 ? 'image' : 'images')

              return (
                <div key={job.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    {statusIcon(job.status)}
                    <div>
                      <p className="line-clamp-1 text-sm text-zinc-200">
                        {job.final_prompt.slice(0, 80)}
                        {job.final_prompt.length > 80 ? '...' : ''}
                      </p>
                      <p className="text-xs text-zinc-600">
                        {new Date(job.created_at).toLocaleString()} &middot; {job.variation_count} {unitLabel}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-400">
                    {job.status}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
