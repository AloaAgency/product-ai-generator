import { NextRequest } from 'next/server'
import { handleSceneVideosGet } from '@/lib/gallery-media'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sceneId: string }> }
) {
  const { sceneId } = await params
  return handleSceneVideosGet(sceneId, 'SceneVideos')
}
