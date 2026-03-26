import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { extractVideoThumbnail, buildThumbnailPath } from '@/lib/image-utils'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 20

function isAdminAuthorized(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return false
  const provided = request.headers.get('x-admin-secret')
  return provided === adminSecret
}

export async function POST(request: NextRequest) {
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), 100)

    const supabase = createServiceClient()

    // Find videos without thumbnails
    const { data: videos, error } = await supabase
      .from(T.generated_images)
      .select('id, storage_path')
      .eq('media_type', 'video')
      .is('thumb_storage_path', null)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!videos || videos.length === 0) {
      return NextResponse.json({
        message: 'No videos without thumbnails found',
        total: 0,
        success: 0,
        errors: 0,
        results: [],
      })
    }

    let success = 0
    let errors = 0
    const results: Array<{ id: string; status: string; error?: string }> = []

    for (const video of videos) {
      try {
        // Download the video
        const { data: videoData, error: downloadErr } = await supabase.storage
          .from('generated-videos')
          .download(video.storage_path)

        if (downloadErr || !videoData) {
          results.push({ id: video.id, status: 'error', error: `Download failed: ${downloadErr?.message}` })
          errors++
          continue
        }

        const videoBuffer = Buffer.from(await videoData.arrayBuffer())

        // Extract thumbnail
        const thumb = await extractVideoThumbnail(videoBuffer)
        const thumbPath = buildThumbnailPath(video.storage_path, thumb.extension)

        // Upload thumbnail
        const { error: uploadErr } = await supabase.storage
          .from('generated-videos')
          .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })

        if (uploadErr) {
          results.push({ id: video.id, status: 'error', error: `Upload failed: ${uploadErr.message}` })
          errors++
          continue
        }

        // Update DB record
        const { error: updateErr } = await supabase
          .from(T.generated_images)
          .update({ thumb_storage_path: thumbPath })
          .eq('id', video.id)

        if (updateErr) {
          results.push({ id: video.id, status: 'error', error: `DB update failed: ${updateErr.message}` })
          errors++
          continue
        }

        results.push({ id: video.id, status: 'ok' })
        success++
      } catch (err) {
        results.push({ id: video.id, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' })
        errors++
      }
    }

    return NextResponse.json({
      total: videos.length,
      success,
      errors,
      results,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
