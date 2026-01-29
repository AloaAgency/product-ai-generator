import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL = 6 * 60 * 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  try {
    const { sceneId } = await params
    const supabase = createServiceClient()

    const { data: videos, error } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('scene_id', sceneId)
      .eq('media_type', 'video')
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Sign video URLs
    const paths = (videos || []).map((v) => v.storage_path).filter(Boolean) as string[]
    let signedMap = new Map<string, string>()
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage
        .from('generated-videos')
        .createSignedUrls(paths, SIGNED_URL_TTL)
      if (signed) {
        signedMap = new Map(
          signed.filter((s) => s?.signedUrl && s?.path).map((s) => [s.path!, s.signedUrl])
        )
      }
    }

    const result = (videos || []).map((v) => ({
      ...v,
      public_url: v.storage_path ? (signedMap.get(v.storage_path) ?? null) : null,
    }))

    return NextResponse.json({ videos: result })
  } catch (err) {
    console.error('[SceneVideos] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
