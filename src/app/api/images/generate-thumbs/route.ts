import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { createThumbnail, buildThumbnailPath } from '@/lib/image-utils'
import { isUuid, parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

/**
 * POST /api/images/generate-thumbs
 * Body: { image_ids: string[] }
 *
 * Downloads each image from storage and creates a 480px WebP thumbnail.
 * Called after manual gallery uploads to ensure thumbnails exist.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const imageIds = body.image_ids as string[]
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return NextResponse.json({ error: 'image_ids required' }, { status: 400 })
    }
    if (imageIds.some((id) => typeof id !== 'string' || !isUuid(id))) {
      return NextResponse.json({ error: 'image_ids must be valid UUIDs' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Fetch image records that are missing thumbnails
    const { data: images, error } = await supabase
      .from(T.generated_images)
      .select('id, storage_path, media_type')
      .in('id', imageIds.slice(0, 50))
      .is('thumb_storage_path', null)

    if (error) {
      logger.error('[GenerateThumbs] DB error fetching images:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!images || images.length === 0) {
      return NextResponse.json({ processed: 0 })
    }

    let success = 0
    for (const img of images) {
      if (img.media_type === 'video') continue
      try {
        const { data: fileData, error: dlErr } = await supabase.storage
          .from('generated-images')
          .download(img.storage_path)

        if (dlErr || !fileData) continue

        const buffer = Buffer.from(await fileData.arrayBuffer())
        const thumb = await createThumbnail(buffer)
        const thumbPath = buildThumbnailPath(img.storage_path, thumb.extension)

        const { error: upErr } = await supabase.storage
          .from('generated-images')
          .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType, upsert: true })

        if (upErr) continue

        await supabase
          .from(T.generated_images)
          .update({ thumb_storage_path: thumbPath })
          .eq('id', img.id)

        success++
      } catch (err) {
        logger.warn('[GenerateThumbs] Skipping image', img.id, ':', err)
      }
    }

    return NextResponse.json({ processed: success })
  } catch (err) {
    logger.error('[GenerateThumbs] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
