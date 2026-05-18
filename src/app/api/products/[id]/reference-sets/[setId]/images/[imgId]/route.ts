import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string; imgId: string }> }
) {
  try {
    const { imgId } = await params
    const supabase = createServiceClient()

    // Get the image record to find storage path
    const { data: image, error: fetchError } = await supabase
      .from(T.reference_images)
      .select('*')
      .eq('id', imgId)
      .single()

    if (fetchError || !image) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 })
    }

    // Delete from storage
    const { error: storageError } = await supabase.storage
      .from('reference-images')
      .remove([image.storage_path])

    if (storageError) {
      console.error('[ReferenceImageDelete] Storage deletion failed:', storageError)
      return NextResponse.json({ error: 'Failed to delete image from storage' }, { status: 500 })
    }

    // Delete from DB
    const { error: dbError } = await supabase
      .from(T.reference_images)
      .delete()
      .eq('id', imgId)

    if (dbError) {
      console.error('[ReferenceImageDelete] DB deletion failed:', dbError)
      return NextResponse.json({ error: 'Failed to delete image record' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
