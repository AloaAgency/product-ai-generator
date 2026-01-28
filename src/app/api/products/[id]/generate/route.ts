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
import type { Product, ReferenceSet, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from(T.generation_jobs)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 })
    }
    return NextResponse.json(data || [])
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params

  try {
    const body = await request.json()
    const {
      prompt_template_id = null,
      prompt_text,
      variation_count = 15,
      resolution = '4K',
      aspect_ratio = '16:9',
      reference_set_id = null,
    } = body

    if (!prompt_text) {
      return NextResponse.json({ error: 'prompt_text is required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Fetch product
    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select('*')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Find reference set: use provided ID or fall back to active set
    let refSet: ReferenceSet | null = null
    if (reference_set_id) {
      const { data, error } = await supabase
        .from(T.reference_sets)
        .select('*')
        .eq('id', reference_set_id)
        .eq('product_id', productId)
        .single()
      if (error || !data) {
        return NextResponse.json(
          { error: 'Reference set not found' },
          { status: 400 }
        )
      }
      refSet = data as ReferenceSet
    } else {
      const { data, error } = await supabase
        .from(T.reference_sets)
        .select('*')
        .eq('product_id', productId)
        .eq('is_active', true)
        .single()
      if (error || !data) {
        return NextResponse.json(
          { error: 'No active reference set found for this product' },
          { status: 400 }
        )
      }
      refSet = data as ReferenceSet
    }

    // Fetch reference images
    const { data: refImages } = await supabase
      .from(T.reference_images)
      .select('*')
      .eq('reference_set_id', refSet.id)
      .order('display_order', { ascending: true })

    const referenceImages: ReferenceImage[] = refImages || []

    // Build final prompt
    const finalPrompt = buildFullPrompt(
      prompt_text,
      (product as Product).global_style_settings,
      referenceImages.length
    )

    // Insert job record
    const { data: job, error: jobError } = await supabase
      .from(T.generation_jobs)
      .insert({
        product_id: productId,
        prompt_template_id,
        reference_set_id: refSet.id,
        final_prompt: finalPrompt,
        variation_count,
        resolution,
        aspect_ratio,
        status: 'pending',
        completed_count: 0,
        failed_count: 0,
        generation_model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      })
      .select()
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Failed to create generation job' }, { status: 500 })
    }

    // Fire-and-forget background generation
    ;(async () => {
      try {
        const bgSupabase = createServiceClient()

        // Update job to running
        await bgSupabase
          .from(T.generation_jobs)
          .update({ status: 'running', started_at: new Date().toISOString() })
          .eq('id', job.id)

        const promptSlug = slugify(prompt_text, 30)

        for (let i = 1; i <= variation_count; i++) {
          try {
            // Download each reference image and convert to base64
            const refImagesBase64: { mimeType: string; base64: string }[] = []
            for (const refImg of referenceImages) {
              const { data: fileData } = await bgSupabase.storage
                .from('reference-images')
                .download(refImg.storage_path)

              if (fileData) {
                const arrayBuffer = await fileData.arrayBuffer()
                const base64 = Buffer.from(arrayBuffer).toString('base64')
                refImagesBase64.push({ mimeType: refImg.mime_type, base64 })
              }
            }

            // Generate image
            const result = await generateGeminiImage({
              prompt: finalPrompt,
              resolution: resolution as '2K' | '4K',
              aspectRatio: aspect_ratio as '16:9' | '1:1' | '9:16',
              referenceImages: refImagesBase64,
            })

            const imageBuffer = Buffer.from(result.base64Data, 'base64')
            const ext = resolveExtension(result.mimeType)

            // Create thumbnail and preview
            const thumb = await createThumbnail(imageBuffer)
            const preview = await createPreview(imageBuffer)

            // Build storage paths
            const storagePath = buildImageStoragePath(productId, job.id, i, promptSlug, ext)
            const thumbPath = buildThumbnailPath(storagePath, thumb.extension)
            const previewPath = buildPreviewPath(storagePath, preview.extension)

            // Upload original
            await bgSupabase.storage
              .from('generated-images')
              .upload(storagePath, imageBuffer, { contentType: result.mimeType })

            // Upload thumbnail
            await bgSupabase.storage
              .from('generated-images')
              .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })

            // Upload preview
            await bgSupabase.storage
              .from('generated-images')
              .upload(previewPath, preview.buffer, { contentType: preview.mimeType })

            // Insert generated_images record
            await bgSupabase.from(T.generated_images).insert({
              job_id: job.id,
              variation_number: i,
              storage_path: storagePath,
              thumb_storage_path: thumbPath,
              preview_storage_path: previewPath,
              mime_type: result.mimeType,
              file_size: imageBuffer.length,
              approval_status: 'pending',
            })

            // Update completed count
            await bgSupabase
              .from(T.generation_jobs)
              .update({ completed_count: i - (job.failed_count || 0) })
              .eq('id', job.id)
          } catch (varError) {
            console.error(`[Generate] Variation ${i} failed:`, varError)
            try {
              const { data: current } = await bgSupabase
                .from(T.generation_jobs)
                .select('failed_count')
                .eq('id', job.id)
                .single()
              if (current) {
                await bgSupabase
                  .from(T.generation_jobs)
                  .update({ failed_count: (current.failed_count || 0) + 1 })
                  .eq('id', job.id)
              }
            } catch { /* ignore */ }
          }

          // Wait 500ms between variations
          if (i < variation_count) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }

        // Mark job as completed
        await bgSupabase
          .from(T.generation_jobs)
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', job.id)
      } catch (err) {
        console.error('[Generate] Background job failed:', err)
        const bgSupabase = createServiceClient()
        await bgSupabase
          .from(T.generation_jobs)
          .update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Unknown error',
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id)
      }
    })()

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    console.error('[Generate] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
