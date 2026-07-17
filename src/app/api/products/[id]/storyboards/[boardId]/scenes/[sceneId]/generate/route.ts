import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import { parseRequestBody } from '@/lib/request-guards'
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
import { logError } from '@/lib/error-logger'
import { logger } from '@/lib/server-logger'

/** The only reference-image columns this route needs — enough to download and re-encode each file. */
type SceneReferenceImage = Pick<ReferenceImage, 'storage_path' | 'mime_type'>

async function generateAndStoreImage(
  supabase: ReturnType<typeof createServiceClient>,
  productId: string,
  prompt: string,
  settings: Product['global_style_settings'],
  referenceImages: SceneReferenceImage[],
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

  const finalPrompt = buildFullPrompt(prompt, settings, [
    { role: 'subject', count: refImagesBase64.length },
  ])

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
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const frame = body.frame as string // 'start' | 'end' | 'both'
    const referenceSetId = body.reference_set_id as string | undefined

    if (!['start', 'end', 'both'].includes(frame)) {
      return NextResponse.json({ error: 'frame must be "start", "end", or "both"' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const fetchRefImages = (setId: string) =>
      supabase
        .from(T.reference_images)
        .select('storage_path, mime_type')
        .eq('reference_set_id', setId)
        .order('display_order', { ascending: true })

    // Fetch scene, product (with project styles via JOIN), and the reference
    // lookup in one parallel batch — all three are independent. When the client
    // supplies reference_set_id we can fetch its images here directly; otherwise
    // we resolve the active set now and fetch its images right after, so the
    // pre-generation phase is 1–2 round-trip stages instead of 3.
    // The product select only pulls global_style_settings — the sole product
    // column this route reads.
    const [
      { data: scene, error: sceneError },
      { data: product },
      refLookup,
    ] = await Promise.all([
      supabase.from(T.storyboard_scenes).select('*').eq('id', sceneId).single(),
      supabase
        .from(T.products)
        .select(`global_style_settings, ${T.projects}!fk_products_project(global_style_settings)`)
        .eq('id', productId)
        .single(),
      referenceSetId
        ? fetchRefImages(referenceSetId).then((r) => ({ images: (r.data ?? []) as SceneReferenceImage[] }))
        : supabase
            .from(T.reference_sets)
            .select('id')
            .eq('product_id', productId)
            .eq('is_active', true)
            .single()
            .then((r) => ({ activeSetId: (r.data?.id ?? undefined) as string | undefined })),
    ])

    if (sceneError || !scene) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    }

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Resolve API key from product-level settings first, then project-level defaults.
    const productWithProject = product as unknown as Pick<Product, 'global_style_settings'> & {
      prodai_projects: { global_style_settings: Product['global_style_settings'] } | null
    }
    let geminiApiKey = resolveGoogleApiKey(productWithProject.global_style_settings)
    if (!geminiApiKey) {
      geminiApiKey = resolveGoogleApiKey(productWithProject.prodai_projects?.global_style_settings ?? null)
    }

    // Resolve reference images: already fetched above when the client named a
    // set; otherwise fetch from the active set resolved in the parallel batch.
    let referenceImages: SceneReferenceImage[]
    if ('images' in refLookup) {
      referenceImages = refLookup.images
    } else {
      if (!refLookup.activeSetId) {
        return NextResponse.json({ error: 'No reference set found' }, { status: 400 })
      }
      const { data: refImages } = await fetchRefImages(refLookup.activeSetId)
      referenceImages = (refImages ?? []) as SceneReferenceImage[]
    }

    const settings = productWithProject.global_style_settings

    const result: { start_frame_image_id?: string; end_frame_image_id?: string } = {}
    // Row returned by the most recent frame-link update — reused as the response
    // body so the happy path doesn't need a final refetch of the scene.
    let updatedScene: Record<string, unknown> | null = null

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
      const { data: sceneAfterStart, error: startFrameUpdateError } = await supabase
        .from(T.storyboard_scenes)
        .update({ start_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
        .select()
        .single()
      if (startFrameUpdateError) {
        logger.error('[Scene Generate] Failed to link start frame to scene:', startFrameUpdateError)
      } else {
        updatedScene = sceneAfterStart
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
      const { data: sceneAfterEnd, error: endFrameUpdateError } = await supabase
        .from(T.storyboard_scenes)
        .update({ end_frame_image_id: imageId, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
        .select()
        .single()
      if (endFrameUpdateError) {
        logger.error('[Scene Generate] Failed to link end frame to scene:', endFrameUpdateError)
      } else {
        updatedScene = sceneAfterEnd
      }
    }

    // The frame-link update already returned the updated scene row; only fall
    // back to a fresh select if the update failed (matching the old
    // always-refetch behavior, which also returned a possibly-stale row then).
    if (!updatedScene) {
      const { data: refetched } = await supabase
        .from(T.storyboard_scenes)
        .select('*')
        .eq('id', sceneId)
        .single()
      updatedScene = refetched
    }

    return NextResponse.json(updatedScene)
  } catch (err) {
    logger.error('[Scene Generate] Error:', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/storyboard/scenes/generate',
      errorContext: { sceneId },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
