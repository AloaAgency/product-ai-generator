import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import { generateGeminiImage } from '@/lib/gemini'
import {
  createThumbnail,
  createPreview,
  buildImageStoragePath,
  buildThumbnailPath,
  buildPreviewPath,
  slugify,
  resolveExtension,
} from '@/lib/image-utils'
import type { Product, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'

async function generateAndStoreImage(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string,
  prompt: string,
  settings: Product['global_style_settings'],
  referenceImages: ReferenceImage[],
  extraReferenceBase64?: { mimeType: string; base64: string },
  sceneId?: string,
  sceneName?: string | null,
) {
  // Download reference images
  const refImagesBase64: { mimeType: string; base64: string }[] = []
  for (const refImg of referenceImages) {
    const { data: fileData } = await supabase.storage
      .from('reference-images')
      .download(refImg.storage_path)
    if (fileData) {
      const arrayBuffer = await fileData.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')
      refImagesBase64.push({ mimeType: refImg.mime_type, base64 })
    }
  }

  // Add extra reference (e.g. start frame for end frame generation)
  if (extraReferenceBase64) {
    refImagesBase64.push(extraReferenceBase64)
  }

  const finalPrompt = buildFullPrompt(prompt, settings, refImagesBase64.length)

  const result = await generateGeminiImage({
    prompt: finalPrompt,
    resolution: settings.default_resolution as '2K' | '4K' | undefined,
    aspectRatio: settings.default_aspect_ratio as '16:9' | '1:1' | '9:16' | undefined,
    referenceImages: refImagesBase64,
  })

  const imageBuffer = Buffer.from(result.base64Data, 'base64')
  const ext = resolveExtension(result.mimeType)
  const thumb = await createThumbnail(imageBuffer)
  const preview = await createPreview(imageBuffer)

  // Use a dummy job id for scene-generated images
  const jobId = 'scene-gen'
  const promptSlug = slugify(prompt, 30)
  const storagePath = buildImageStoragePath(productId, jobId, Date.now(), promptSlug, ext)
  const thumbPath = buildThumbnailPath(storagePath, thumb.extension)
  const previewPath = buildPreviewPath(storagePath, preview.extension)

  await supabase.storage.from('generated-images').upload(storagePath, imageBuffer, { contentType: result.mimeType })
  await supabase.storage.from('generated-images').upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })
  await supabase.storage.from('generated-images').upload(previewPath, preview.buffer, { contentType: preview.mimeType })

  const { data: imgRecord, error: imgError } = await supabase
    .from(T.generated_images)
    .insert({
      job_id: null,
      variation_number: 1,
      storage_path: storagePath,
      thumb_storage_path: thumbPath,
      preview_storage_path: previewPath,
      mime_type: result.mimeType,
      file_size: imageBuffer.length,
      approval_status: 'pending',
      media_type: 'image',
      scene_id: sceneId ?? null,
      scene_name: sceneName ?? null,
    })
    .select()
    .single()

  if (imgError || !imgRecord) throw new Error('Failed to insert generated image record')

  return { imageId: imgRecord.id, base64: result.base64Data, mimeType: result.mimeType }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  const { id: productId, sceneId } = await params

  try {
    const body = await request.json()
    const frame: string = body.frame // 'start' | 'end' | 'both'
    const referenceSetId: string | undefined = body.reference_set_id

    if (!['start', 'end', 'both'].includes(frame)) {
      return NextResponse.json({ error: 'frame must be "start", "end", or "both"' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Fetch scene
    const { data: scene, error: sceneError } = await supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('id', sceneId)
      .single()

    if (sceneError || !scene) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    }

    // Fetch product
    const { data: product } = await supabase
      .from(T.products)
      .select('*')
      .eq('id', productId)
      .single()

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Find reference set
    let refSetId = referenceSetId
    if (!refSetId) {
      const { data: activeSet } = await supabase
        .from(T.reference_sets)
        .select('id')
        .eq('product_id', productId)
        .eq('is_active', true)
        .single()
      refSetId = activeSet?.id
    }

    if (!refSetId) {
      return NextResponse.json({ error: 'No reference set found' }, { status: 400 })
    }

    const { data: refImages } = await supabase
      .from(T.reference_images)
      .select('*')
      .eq('reference_set_id', refSetId)
      .order('display_order', { ascending: true })

    const referenceImages: ReferenceImage[] = refImages || []
    const settings = (product as Product).global_style_settings

    const result: { start_frame_image_id?: string; end_frame_image_id?: string } = {}

    // Generate start frame
    if (frame === 'start' || frame === 'both') {
      if (!scene.prompt_text) {
        return NextResponse.json({ error: 'Scene prompt_text is required for start frame' }, { status: 400 })
      }
      const { imageId } = await generateAndStoreImage(
        supabase,
        productId,
        scene.prompt_text,
        settings,
        referenceImages,
        undefined,
        scene.id,
        scene.title
      )
      result.start_frame_image_id = imageId
      await supabase
        .from(T.storyboard_scenes)
        .update({ start_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
    }

    // Generate end frame
    if (frame === 'end' || frame === 'both') {
      const endPrompt = scene.end_frame_prompt || scene.prompt_text
      if (!endPrompt) {
        return NextResponse.json({ error: 'No prompt available for end frame' }, { status: 400 })
      }

      // If start frame exists, use it as additional reference
      let extraRef: { mimeType: string; base64: string } | undefined
      const startImageId = result.start_frame_image_id || scene.start_frame_image_id
      if (startImageId) {
        // Fetch the start frame image to use as reference
        const { data: startImg } = await supabase
          .from(T.generated_images)
          .select('storage_path, mime_type')
          .eq('id', startImageId)
          .single()

        if (startImg) {
          const { data: fileData } = await supabase.storage
            .from('generated-images')
            .download(startImg.storage_path)
          if (fileData) {
            const arrayBuffer = await fileData.arrayBuffer()
            extraRef = {
              mimeType: startImg.mime_type,
              base64: Buffer.from(arrayBuffer).toString('base64'),
            }
          }
        }
      }

      const { imageId } = await generateAndStoreImage(
        supabase,
        productId,
        endPrompt,
        settings,
        referenceImages,
        extraRef,
        scene.id,
        scene.title
      )
      result.end_frame_image_id = imageId
      await supabase
        .from(T.storyboard_scenes)
        .update({ end_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
    }

    // Return updated scene
    const { data: updated } = await supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('id', sceneId)
      .single()

    return NextResponse.json(updated)
  } catch (err) {
    console.error('[Scene Generate] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
