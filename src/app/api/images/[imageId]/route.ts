import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const { imageId } = await params

  try {
    const body = await request.json()
    const updates: Record<string, unknown> = {}

    if ('approval_status' in body) {
      updates.approval_status = body.approval_status
    }
    if ('notes' in body) {
      updates.notes = body.notes
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const { data: image, error } = await supabase
      .from(T.generated_images)
      .update(updates)
      .eq('id', imageId)
      // Return only the mutable fields we changed so client-side signed URLs stay intact.
      .select('id, approval_status, notes')
      .single()

    if (error || !image) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 })
    }

    return NextResponse.json({ image })
  } catch (err) {
    console.error('[ImagePatch] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const { imageId } = await params

  try {
    const supabase = createServiceClient()

    // Fetch the image record first
    const { data: image, error: fetchError } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('id', imageId)
      .single()

    if (fetchError || !image) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 })
    }

    // Delete files from storage
    const pathsToDelete = [
      image.storage_path,
      image.thumb_storage_path,
      image.preview_storage_path,
    ].filter(Boolean) as string[]

    if (pathsToDelete.length > 0) {
      const { error: storageError } = await supabase.storage.from('generated-images').remove(pathsToDelete)
      if (storageError) {
        // Log but continue — the DB record must still be deleted to prevent stale data.
        // Orphaned storage files can be cleaned up via the backfill admin route.
        console.error('[ImageDelete] Storage deletion failed, orphaned files may remain:', storageError)
      }
    }

    // Delete DB record
    const { error: deleteError } = await supabase
      .from(T.generated_images)
      .delete()
      .eq('id', imageId)

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to delete image record' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ImageDelete] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
