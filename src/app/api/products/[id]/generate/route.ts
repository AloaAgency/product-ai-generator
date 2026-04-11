import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import type { Product, Project, ReferenceSet, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'
import { processGenerationJob } from '@/lib/generation-worker'
import { kickWorkerForJob } from '@/lib/video-job-request'

export const runtime = 'nodejs'
export const maxDuration = 300

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
    console.error('[Generate GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
      texture_set_id = null,
      product_image_count = null,
      texture_image_count = null,
      parallelism_override,
      batch_override,
      time_budget_ms_override,
      source_image_id = null,
      lens: overrideLens,
      camera_height: overrideCameraHeight,
      lighting: overrideLighting,
      color_grading: overrideColorGrading,
      style: overrideStyle,
    } = body

    if (!prompt_text) {
      return NextResponse.json({ error: 'prompt_text is required' }, { status: 400 })
    }

    const parsedVariationCount = Number(variation_count)
    if (
      !Number.isInteger(parsedVariationCount) ||
      parsedVariationCount < 1 ||
      parsedVariationCount > 100
    ) {
      return NextResponse.json(
        { error: 'variation_count must be an integer between 1 and 100' },
        { status: 400 }
      )
    }

    const sanitizedVariationCount = parsedVariationCount

    const supabase = createServiceClient()

    // Fetch product and validate source image in parallel (independent queries)
    const refSetQuery = reference_set_id
      ? supabase
          .from(T.reference_sets)
          .select('*')
          .eq('id', reference_set_id)
          .eq('product_id', productId)
          .single()
      : supabase
          .from(T.reference_sets)
          .select('*')
          .eq('product_id', productId)
          .eq('is_active', true)
          .single()

    const [productResult, refSetResult, sourceImgResult] = await Promise.all([
      supabase.from(T.products).select('*').eq('id', productId).single(),
      refSetQuery,
      source_image_id
        ? supabase.from(T.generated_images).select('id').eq('id', source_image_id).single()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (productResult.error || !productResult.data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    if (source_image_id && (sourceImgResult.error || !sourceImgResult.data)) {
      return NextResponse.json({ error: 'Source image not found' }, { status: 400 })
    }

    const product = productResult.data

    // Find reference set: use provided ID or fall back to active set
    let refSet: ReferenceSet | null = null
    {
      const { data, error } = refSetResult
      if (error || !data) {
        return NextResponse.json(
          { error: reference_set_id ? 'Reference set not found' : 'No active reference set found for this product' },
          { status: 400 }
        )
      }
      refSet = data as ReferenceSet
    }

    if (refSet.type && refSet.type !== 'product') {
      return NextResponse.json(
        { error: 'reference_set_id must be a product reference set' },
        { status: 400 }
      )
    }

    // Fetch reference images, texture set, and project styles in parallel
    const typedProduct = product as Product
    const [refImagesResult, textureSetResult, projectResult] = await Promise.all([
      supabase
        .from(T.reference_images)
        .select('*')
        .eq('reference_set_id', refSet.id)
        .order('display_order', { ascending: true }),
      texture_set_id
        ? supabase
            .from(T.reference_sets)
            .select('*')
            .eq('id', texture_set_id)
            .eq('product_id', productId)
            .single()
        : Promise.resolve({ data: null, error: null }),
      typedProduct.project_id
        ? supabase
            .from(T.projects)
            .select('global_style_settings')
            .eq('id', typedProduct.project_id)
            .single()
        : Promise.resolve({ data: null }),
    ])

    const referenceImages: ReferenceImage[] = refImagesResult.data || []

    // Validate and resolve texture set
    let textureSet: ReferenceSet | null = null
    let textureImages: ReferenceImage[] = []
    if (texture_set_id) {
      if (textureSetResult.error || !textureSetResult.data) {
        return NextResponse.json({ error: 'Texture set not found' }, { status: 400 })
      }
      textureSet = textureSetResult.data as ReferenceSet
      if (textureSet.type && textureSet.type !== 'texture') {
        return NextResponse.json(
          { error: 'texture_set_id must be a texture reference set' },
          { status: 400 }
        )
      }
      const { data: texImages } = await supabase
        .from(T.reference_images)
        .select('*')
        .eq('reference_set_id', textureSet.id)
        .order('display_order', { ascending: true })
      textureImages = texImages || []
    }

    // Calculate actual image counts to use
    const maxTotalImages = 14
    const availableProductImages = referenceImages.length
    const availableTextureImages = textureImages.length

    let finalProductCount = product_image_count ?? availableProductImages
    let finalTextureCount = texture_set_id ? (texture_image_count ?? availableTextureImages) : 0

    // Cap to available images
    finalProductCount = Math.min(finalProductCount, availableProductImages)
    finalTextureCount = Math.min(finalTextureCount, availableTextureImages)

    // Validate total doesn't exceed limit
    if (finalProductCount + finalTextureCount > maxTotalImages) {
      return NextResponse.json(
        { error: `Total image count (${finalProductCount + finalTextureCount}) exceeds maximum of ${maxTotalImages}` },
        { status: 400 }
      )
    }

    const projectStyles = (projectResult.data as Project | null)?.global_style_settings ?? {}
    const mergedSettings = mergeStyles(projectStyles, typedProduct.global_style_settings)

    // Apply per-generation photographic overrides
    if (overrideLens) mergedSettings.lens = overrideLens
    if (overrideCameraHeight) mergedSettings.camera_height = overrideCameraHeight
    if (overrideLighting) mergedSettings.lighting = overrideLighting
    if (overrideColorGrading) mergedSettings.color_grading = overrideColorGrading
    if (overrideStyle) mergedSettings.style = overrideStyle

    // Build final prompt
    let userPrompt = prompt_text
    if (source_image_id) {
      userPrompt = `Using the provided source image as a base, recreate it with the following modifications: ${prompt_text}. Keep the rest of the image as close to the original as possible.`
    }
    const finalPrompt = buildFullPrompt(
      userPrompt,
      mergedSettings,
      finalProductCount,
      finalTextureCount
    )

    // Insert job record
    const { data: job, error: jobError } = await supabase
      .from(T.generation_jobs)
      .insert({
        product_id: productId,
        prompt_template_id,
        reference_set_id: refSet.id,
        texture_set_id: textureSet?.id ?? null,
        product_image_count: finalProductCount,
        texture_image_count: finalTextureCount > 0 ? finalTextureCount : null,
        final_prompt: finalPrompt,
        variation_count: sanitizedVariationCount,
        resolution,
        aspect_ratio,
        status: 'pending',
        completed_count: 0,
        failed_count: 0,
        generation_model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
        job_type: 'image',
        source_image_id: source_image_id || null,
      })
      .select()
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Failed to create generation job' }, { status: 500 })
    }

    const shouldRunInline =
      process.env.INLINE_GENERATION === 'true' || process.env.NODE_ENV === 'development'

    if (shouldRunInline) {
      const batchSizeRaw = Number(process.env.GENERATION_BATCH_SIZE)
      const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
        ? batchSizeRaw
        : sanitizedVariationCount
      const parallelismRaw = Number(process.env.GENERATION_PARALLELISM)
      const parallelism = Number.isFinite(parallelismRaw) && parallelismRaw > 0 ? parallelismRaw : 1
      const timeBudgetMsRaw = Number(process.env.GENERATION_TIME_BUDGET_MS)
      const timeBudgetMs = Number.isFinite(timeBudgetMsRaw) && timeBudgetMsRaw > 0 ? timeBudgetMsRaw : 760000
      const overrideBatch = Number(batch_override)
      const overrideParallel = Number(parallelism_override)
      const overrideBudget = Number(time_budget_ms_override)
      const finalBatch = Number.isFinite(overrideBatch) && overrideBatch > 0 ? overrideBatch : batchSize
      const finalParallel = Number.isFinite(overrideParallel) && overrideParallel > 0 ? overrideParallel : parallelism
      const finalBudget = Number.isFinite(overrideBudget) && overrideBudget > 0 ? overrideBudget : timeBudgetMs
      void processGenerationJob(job.id, { batchSize: finalBatch, parallelism: finalParallel, timeBudgetMs: finalBudget })
    } else {
      kickWorkerForJob(job.id, request.url, '[Generate]', {
        batch: process.env.GENERATION_BATCH_SIZE ?? '',
        parallel: process.env.GENERATION_PARALLELISM ?? '',
        budget: process.env.GENERATION_TIME_BUDGET_MS ?? '',
      })
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    console.error('[Generate] Error:', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/products/generate',
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  try {
    const scope = new URL(request.url).searchParams.get('scope') || 'active'

    if (!['active', 'failed', 'all', 'log'].includes(scope)) {
      return NextResponse.json({ error: 'Invalid scope. Use "active", "failed", "all", or "log".' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const now = new Date().toISOString()

    let cancelled = 0
    let clearedFailed = 0

    if (scope === 'active' || scope === 'all') {
      const { data, error } = await supabase
        .from(T.generation_jobs)
        .update({
          status: 'cancelled',
          error_message: 'Cancelled by user',
          completed_at: now,
        })
        .eq('product_id', productId)
        .in('status', ['pending', 'running'])
        .select('id')

      if (error) {
        console.error('[Generate DELETE cancel]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      cancelled = data?.length || 0
    }

    if (scope === 'failed' || scope === 'all') {
      const { data, error } = await supabase
        .from(T.generation_jobs)
        .delete()
        .eq('product_id', productId)
        .eq('status', 'failed')
        .select('id')

      if (error) {
        console.error('[Generate DELETE failed]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      clearedFailed = data?.length || 0
    }

    let clearedLog = 0
    if (scope === 'log') {
      const { data, error } = await supabase
        .from(T.generation_jobs)
        .delete()
        .eq('product_id', productId)
        .in('status', ['completed', 'failed', 'cancelled'])
        .select('id')

      if (error) {
        console.error('[Generate DELETE log]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      clearedLog = data?.length || 0
    }

    return NextResponse.json({ cancelled, cleared_failed: clearedFailed, cleared_log: clearedLog })
  } catch (err) {
    console.error('[Generate DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
