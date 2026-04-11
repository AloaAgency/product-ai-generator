import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB

type Params = { params: Promise<{ id: string; sceneId: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { sceneId } = await params
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
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return NextResponse.json({ error: `File type "${mimeType}" is not allowed. Allowed types: JPEG, PNG, WebP, GIF, AVIF` }, { status: 400 })
    }
    if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: 'File exceeds the 50 MB size limit' }, { status: 400 })
    }

    // Verify the scene exists before issuing a signed URL or creating records
    const { data: sceneExists, error: sceneCheckError } = await supabase
      .from(T.storyboard_scenes)
      .select('id')
      .eq('id', sceneId)
      .single()

    if (sceneCheckError || !sceneExists) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
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
      console.error('[UploadFrame] sign error', signError)
      return NextResponse.json({ error: 'Failed to create upload URL' }, { status: 500 })
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
      console.error('[UploadFrame] insert error', insertError)
      return NextResponse.json({ error: 'Failed to create image record' }, { status: 500 })
    }

    // Update the scene's frame ID
    const frameColumn = slot === 'start' ? 'start_frame_image_id' : 'end_frame_image_id'
    const sceneUpdates: Record<string, unknown> = {
      [frameColumn]: image.id,
      updated_at: new Date().toISOString(),
    }
    if (slot === 'end') sceneUpdates.paired = true

    await supabase
      .from(T.storyboard_scenes)
      .update(sceneUpdates)
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
