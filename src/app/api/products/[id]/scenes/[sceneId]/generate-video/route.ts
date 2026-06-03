import { NextRequest } from 'next/server'
import { handleSceneGenerateVideoPost } from '@/lib/video-job-request'

export const runtime = 'nodejs'
export const maxDuration = 600
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sceneId: string }> }
) {
  const { id: productId, sceneId } = await params
  return handleSceneGenerateVideoPost(
    request,
    productId,
    sceneId,
    'api/products/scenes/generate-video'
  )
}
