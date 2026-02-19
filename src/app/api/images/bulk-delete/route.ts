import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function POST(request: NextRequest) {
  try {
    const { imageIds } = await request.json()

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return NextResponse.json({ error: 'imageIds must be a non-empty array' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Fetch all image records
    const { data: images, error: fetchError } = await supabase
      .from(T.generated_images)
      .select('*')
      .in('id', imageIds)

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
      .in('id', imageIds)

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to delete image records' }, { status: 500 })
    }

    return NextResponse.json({ deleted: images.length })
  } catch (err) {
    console.error('[BulkDelete] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
