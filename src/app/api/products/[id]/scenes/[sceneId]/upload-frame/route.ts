import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; sceneId: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id: productId, sceneId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    const slot = body.slot as 'start' | 'end'
    const fileName = body.file_name as string
    const mimeType = body.mime_type as string
    const fileSize = body.file_size as number

    if (!slot || !['start', 'end'].includes(slot)) {
      return NextResponse.json({ error: 'slot must be "start" or "end"' }, { status: 400 })
    }
    if (!fileName || !mimeType) {
      return NextResponse.json({ error: 'file_name and mime_type are required' }, { status: 400 })
    }

    const extension = fileName.includes('.')
      ? `.${fileName.split('.').pop()?.toLowerCase()}`
      : ''
    const storageFileName = `${slot}-${Date.now()}-${randomUUID()}${extension}`
    const storagePath = `scenes/${sceneId}/${storageFileName}`

    const { data: signedData, error: signError } = await supabase.storage
      .from('generated-images')
      .createSignedUploadUrl(storagePath, { upsert: true })

    if (signError || !signedData?.signedUrl) {
      return NextResponse.json({ error: signError?.message || 'Failed to create upload URL' }, { status: 500 })
    }

    // Create the image record
    const { data: image, error: insertError } = await supabase
      .from(T.generated_images)
      .insert({
        id: randomUUID(),
        scene_id: sceneId,
        storage_path: storagePath,
        file_name: fileName,
        mime_type: mimeType,
        file_size: fileSize || null,
        media_type: 'image',
        variation_number: 0,
      })
      .select()
      .single()

    if (insertError || !image) {
      return NextResponse.json({ error: insertError?.message || 'Failed to create image record' }, { status: 500 })
    }

    // Update the scene's frame ID
    const frameColumn = slot === 'start' ? 'start_frame_image_id' : 'end_frame_image_id'
    await supabase
      .from(T.storyboard_scenes)
      .update({ [frameColumn]: image.id, updated_at: new Date().toISOString() })
      .eq('id', sceneId)

    return NextResponse.json({
      signed_url: signedData.signedUrl,
      image,
    }, { status: 201 })
  } catch (err) {
    console.error('[UploadFrame] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
