'use client'

import { use, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Image as ImageIcon, Video } from 'lucide-react'
import { ImageGenerateTab } from './_components/ImageGenerateTab'
import { VideoGenerateTab } from './_components/VideoGenerateTab'

export default function GeneratePage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>
}) {
  const { id } = use(params)
  const searchParams = useSearchParams()
  const initialPrompt = searchParams.get('prompt') ?? undefined
  const initialRefSetId = searchParams.get('reference_set_id') ?? undefined
  const initialTextureSetId = searchParams.get('texture_set_id') ?? undefined
  const initialProductImageCount = searchParams.get('product_image_count') ?? undefined
  const initialTextureImageCount = searchParams.get('texture_image_count') ?? undefined
  const [activeTab, setActiveTab] = useState<'image' | 'video'>('image')

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 p-4 sm:p-6 space-y-6 sm:space-y-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold">Generate</h1>

      {/* Tab Toggle */}
      <div className="grid w-full max-w-sm grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-zinc-800/50 p-1 sm:inline-grid sm:w-auto">
        <button
          onClick={() => setActiveTab('image')}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'image'
              ? 'bg-blue-600 text-white'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
          }`}
        >
          <ImageIcon className="h-4 w-4" />
          Image
        </button>
        <button
          onClick={() => setActiveTab('video')}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'video'
              ? 'bg-purple-600 text-white'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
          }`}
        >
          <Video className="h-4 w-4" />
          Video
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'image' ? (
        <ImageGenerateTab
          productId={id}
          initialPrompt={initialPrompt}
          initialRefSetId={initialRefSetId}
          initialTextureSetId={initialTextureSetId}
          initialProductImageCount={initialProductImageCount}
          initialTextureImageCount={initialTextureImageCount}
        />
      ) : (
        <VideoGenerateTab productId={id} />
      )}
    </div>
  )
}
