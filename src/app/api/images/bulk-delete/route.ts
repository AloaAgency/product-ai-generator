import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { sanitizePublicErrorMessage, sanitizeUuidArray, parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

const MAX_BULK_DELETE = 200

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    const { imageIds } = body as { imageIds?: string[] }

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return NextResponse.json({ error: 'imageIds must be a non-empty array' }, { status: 400 })
    }

    const sanitizedImageIds = sanitizeUuidArray(imageIds, 'image id')

    if (sanitizedImageIds.length > MAX_BULK_DELETE) {
      return NextResponse.json(
        { error: `Cannot delete more than ${MAX_BULK_DELETE} images in a single request` },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Fetch all image records — the storage paths plus media_type (which
    // determines the bucket) are all that's needed to delete.
    const { data: images, error: fetchError } = await supabase
      .from(T.generated_images)
      .select('storage_path, thumb_storage_path, preview_storage_path, media_type')
      .in('id', sanitizedImageIds)

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ deleted: 0 })
    }

    // Collect storage paths to delete, split by bucket. Video records (and
    // their thumbnails) live in the generated-videos bucket — removing their
    // paths from generated-images would silently no-op and leave the actual
    // files orphaned.
    const imagePaths: string[] = []
    const videoPaths: string[] = []
    for (const img of images) {
      const target = img.media_type === 'video' ? videoPaths : imagePaths
      if (img.storage_path) target.push(img.storage_path)
      if (img.thumb_storage_path) target.push(img.thumb_storage_path)
      if (img.preview_storage_path) target.push(img.preview_storage_path)
    }

    // Delete storage files from each bucket
    const [imageRemoval, videoRemoval] = await Promise.all([
      imagePaths.length > 0
        ? supabase.storage.from('generated-images').remove(imagePaths)
        : Promise.resolve({ error: null }),
      videoPaths.length > 0
        ? supabase.storage.from('generated-videos').remove(videoPaths)
        : Promise.resolve({ error: null }),
    ])
    if (imageRemoval.error) {
      logger.error('[BulkDelete] Image storage deletion failed, orphaned files may remain:', imageRemoval.error)
    }
    if (videoRemoval.error) {
      logger.error('[BulkDelete] Video storage deletion failed, orphaned files may remain:', videoRemoval.error)
    }

    // Delete DB records
    const { error: deleteError } = await supabase
      .from(T.generated_images)
      .delete()
      .in('id', sanitizedImageIds)

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to delete image records' }, { status: 500 })
    }

    return NextResponse.json({ deleted: images.length })
  } catch (err) {
    logger.error(`[BulkDelete] ${sanitizePublicErrorMessage(err, { fallback: 'Unexpected error' })}`)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
