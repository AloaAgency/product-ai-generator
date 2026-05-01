import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import { generateGeminiImage } from '@/lib/gemini'
import {
  createThumbnailAndPreview,
  buildImageStoragePath,
  buildThumbnailPath,
  buildPreviewPath,
  slugify,
  resolveExtension,
} from '@/lib/image-utils'
import type { Product, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { resolveGoogleApiKey } from '@/lib/google-api-keys'

async function generateAndStoreImage(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string,
  prompt: string,
  settings: Product['global_style_settings'],
  referenceImages: ReferenceImage[],
  extraReferenceBase64?: { mimeType: string; base64: string },
  sceneId?: string,
  sceneName?: string | null,
  geminiApiKey?: string,
) {
  // Download reference images in parallel
  const refImagesBase64: { mimeType: string; base64: string }[] = (
    await Promise.all(
      referenceImages.map(async (refImg) => {
        const { data: fileData } = await supabase.storage
          .from('reference-images')
          .download(refImg.storage_path)
        if (!fileData) return null
        const base64 = Buffer.from(await fileData.arrayBuffer()).toString('base64')
        return { mimeType: refImg.mime_type, base64 }
      })
    )
  ).filter((x): x is { mimeType: string; base64: string } => x !== null)

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
    apiKey: geminiApiKey,
  })

  const imageBuffer = Buffer.from(result.base64Data, 'base64')
  const ext = resolveExtension(result.mimeType)
  const [thumb, preview] = await createThumbnailAndPreview(imageBuffer)

  // Use a dummy job id for scene-generated images
  const jobId = 'scene-gen'
  const promptSlug = slugify(prompt, 30)
  const storagePath = buildImageStoragePath(productId, jobId, Date.now(), promptSlug, ext)
  const thumbPath = buildThumbnailPath(storagePath, thumb.extension)
  const previewPath = buildPreviewPath(storagePath, preview.extension)

  await Promise.all([
    supabase.storage.from('generated-images').upload(storagePath, imageBuffer, { contentType: result.mimeType }),
    supabase.storage.from('generated-images').upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType }),
    supabase.storage.from('generated-images').upload(previewPath, preview.buffer, { contentType: preview.mimeType }),
  ])

  const { data: imgRecord, error: imgError } = await supabase
    .from(T.generated_images)
    .insert({
      product_id: productId,
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

    // Fetch scene and product (with project styles via JOIN) in parallel — independent queries.
    // Including project styles in the product JOIN avoids a second sequential round-trip
    // when the product has no per-product API key (the common case).
    const [
      { data: scene, error: sceneError },
      { data: product },
    ] = await Promise.all([
      supabase.from(T.storyboard_scenes).select('*').eq('id', sceneId).single(),
      supabase
        .from(T.products)
        .select(`*, ${T.projects}!fk_products_project(global_style_settings)`)
        .eq('id', productId)
        .single(),
    ])

    if (sceneError || !scene) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    }

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Resolve API key from product-level settings first, then project-level defaults.
    const productWithProject = product as Product & {
      prodai_projects: { global_style_settings: Product['global_style_settings'] } | null
    }
    let geminiApiKey = resolveGoogleApiKey(productWithProject.global_style_settings)
    if (!geminiApiKey) {
      geminiApiKey = resolveGoogleApiKey(productWithProject.prodai_projects?.global_style_settings ?? null)
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
    const settings = productWithProject.global_style_settings

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
        scene.title,
        geminiApiKey
      )
      result.start_frame_image_id = imageId
      const { error: startFrameUpdateError } = await supabase
        .from(T.storyboard_scenes)
        .update({ start_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
      if (startFrameUpdateError) {
        console.error('[Scene Generate] Failed to link start frame to scene:', startFrameUpdateError)
      }
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
        scene.title,
        geminiApiKey
      )
      result.end_frame_image_id = imageId
      const { error: endFrameUpdateError } = await supabase
        .from(T.storyboard_scenes)
        .update({ end_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
      if (endFrameUpdateError) {
        console.error('[Scene Generate] Failed to link end frame to scene:', endFrameUpdateError)
      }
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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
