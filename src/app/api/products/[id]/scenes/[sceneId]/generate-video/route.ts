import { NextRequest, NextResponse } from 'next/server'
import { generateSceneVideo } from '@/lib/video-generation'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sceneId: string }> }
) {
  try {
    const { id: productId, sceneId } = await params
    const body = await request.json()
    const model: string = body.model || 'veo3'

    const record = await generateSceneVideo(productId, sceneId, model)
    return NextResponse.json(record, { status: 201 })
  } catch (err) {
    console.error('[GenerateVideo] Error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    const status = message === 'Scene not found' ? 404
      : message === 'Scene has no motion prompt' ? 400
      : message.startsWith('Unsupported model') ? 400
      : 500
    return NextResponse.json({ error: message }, { status })
  }
}
