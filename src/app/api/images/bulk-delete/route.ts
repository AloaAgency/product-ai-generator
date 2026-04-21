import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { sanitizePublicErrorMessage, sanitizeUuidArray } from '@/lib/request-guards'

const MAX_BULK_DELETE = 200

export async function POST(request: NextRequest) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

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

    // Fetch all image records
    const { data: images, error: fetchError } = await supabase
      .from(T.generated_images)
      .select('*')
      .in('id', sanitizedImageIds)

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ deleted: 0 })
    }

    // Collect storage paths to delete
    const imagePaths: string[] = []
    for (const img of images) {
      if (img.storage_path) imagePaths.push(img.storage_path)
      if (img.thumb_storage_path) imagePaths.push(img.thumb_storage_path)
      if (img.preview_storage_path) imagePaths.push(img.preview_storage_path)
    }

    // Delete storage files
    if (imagePaths.length > 0) {
      await supabase.storage.from('generated-images').remove(imagePaths)
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
    console.error(`[BulkDelete] ${sanitizePublicErrorMessage(err, { fallback: 'Unexpected error' })}`)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
