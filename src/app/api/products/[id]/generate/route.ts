import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt, type ReferenceGroup } from '@/lib/prompt-builder'
import { parseRequestBody } from '@/lib/request-guards'
import type { Product, GlobalStyleSettings, ReferenceSet, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'
import { createLogger } from '@/lib/server-logger'
import { processGenerationJob } from '@/lib/generation-worker'
import { kickWorkerForJob } from '@/lib/video-job-request'
import {
  MAX_PROMPT_LENGTH,
  type ReferenceSetSelection,
  parseReferenceSetsInput,
  resolveReferenceImageSelection,
  clampJobsPagination,
  validateVariationCount,
  capStyleValue,
  isValidDeleteScope,
} from '@/lib/generate-route-helpers'

export const runtime = 'nodejs'
export const maxDuration = 300

const log = createLogger('Generate')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  try {
    const { searchParams } = new URL(request.url)
    const { limit, offset } = clampJobsPagination(searchParams.get('limit'), searchParams.get('offset'))
    const status = searchParams.get('status') // optional filter

    const supabase = createServiceClient()
    let query = supabase
      .from(T.generation_jobs)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error } = await query
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 })
    }
    return NextResponse.json(data || [])
  } catch (err) {
    log.error('GET', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/products/generate:GET',
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params

  try {
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const {
      prompt_template_id = null,
      prompt_text,
      variation_count = 15,
      resolution = '4K',
      aspect_ratio = '16:9',
      reference_sets: referenceSetsInput,
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
    if (typeof prompt_text === 'string' && prompt_text.length > MAX_PROMPT_LENGTH) {
      return NextResponse.json({ error: `prompt_text must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 })
    }

    const sanitizedVariationCount = validateVariationCount(variation_count)
    if (sanitizedVariationCount === null) {
      return NextResponse.json(
        { error: 'variation_count must be an integer between 1 and 100' },
        { status: 400 }
      )
    }

    const isFixImage = Boolean(source_image_id)
    const refSetsProvided = Array.isArray(referenceSetsInput) && referenceSetsInput.length > 0
    let parsedRefSets: ReferenceSetSelection[] = []
    if (refSetsProvided || !isFixImage) {
      const parsedRefSetsResult = parseReferenceSetsInput(referenceSetsInput)
      if ('error' in parsedRefSetsResult) {
        return NextResponse.json({ error: parsedRefSetsResult.error }, { status: 400 })
      }
      parsedRefSets = parsedRefSetsResult.sets
    }
    const uniqueSetIds = [...new Set(parsedRefSets.map(s => s.reference_set_id))]

    const supabase = createServiceClient()

    const [productResult, refSetsResult, refImagesResult, sourceImgResult] = await Promise.all([
      // Only global_style_settings is read from the product below — selecting
      // specific columns keeps large unrelated fields out of the payload.
      supabase
        .from(T.products)
        .select(`global_style_settings, ${T.projects}!fk_products_project(global_style_settings)`)
        .eq('id', productId)
        .single(),
      uniqueSetIds.length > 0
        ? supabase
            .from(T.reference_sets)
            .select('*')
            .in('id', uniqueSetIds)
            .eq('product_id', productId)
        : Promise.resolve({ data: [], error: null }),
      uniqueSetIds.length > 0
        ? supabase
            .from(T.reference_images)
            .select('*')
            .in('reference_set_id', uniqueSetIds)
            .order('display_order', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      source_image_id
        ? supabase.from(T.generated_images).select('id').eq('id', source_image_id).single()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (productResult.error || !productResult.data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }
    if (source_image_id && (sourceImgResult.error || !sourceImgResult.data)) {
      return NextResponse.json({ error: 'Source image not found' }, { status: 404 })
    }
    if (refSetsResult.error) {
      return NextResponse.json({ error: 'Failed to load reference sets' }, { status: 500 })
    }

    const refSetsById = new Map<string, ReferenceSet>(
      (refSetsResult.data || []).map(rs => [rs.id, rs as ReferenceSet])
    )
    if (refSetsById.size !== uniqueSetIds.length) {
      return NextResponse.json({ error: 'One or more reference sets not found for this product' }, { status: 400 })
    }

    for (let i = 0; i < parsedRefSets.length; i += 1) {
      const ps = parsedRefSets[i]
      const rs = refSetsById.get(ps.reference_set_id)!
      const expectedType = ps.role === 'subject' ? 'product' : 'texture'
      if (rs.type && rs.type !== expectedType) {
        return NextResponse.json(
          { error: `reference_sets[${i}] role "${ps.role}" doesn't match set type "${rs.type}"` },
          { status: 400 }
        )
      }
    }

    const imagesBySetId = new Map<string, ReferenceImage[]>()
    for (const img of (refImagesResult.data || []) as ReferenceImage[]) {
      if (!img.reference_set_id) continue
      const arr = imagesBySetId.get(img.reference_set_id) ?? []
      arr.push(img)
      imagesBySetId.set(img.reference_set_id, arr)
    }

    const selection = resolveReferenceImageSelection(parsedRefSets, imagesBySetId)
    if ('error' in selection) {
      return NextResponse.json({ error: selection.error }, { status: 400 })
    }
    const { finalCounts, finalSelectedIds } = selection

    // Parent-project styles arrive embedded via the product JOIN above, avoiding a
    // second sequential round-trip (mirrors the suggest-prompts / build-prompt routes).
    const typedProduct = productResult.data as unknown as Pick<Product, 'global_style_settings'> & {
      prodai_projects: { global_style_settings: GlobalStyleSettings } | null
    }
    const projectStyles = typedProduct.prodai_projects?.global_style_settings ?? {}
    const mergedSettings = mergeStyles(projectStyles, typedProduct.global_style_settings)

    // Apply per-generation photographic overrides — cap at MAX_STYLE_VALUE_LEN to prevent
    // oversized or injected values from the request body reaching the AI prompt unchecked.
    const cappedLens = capStyleValue(overrideLens)
    const cappedCameraHeight = capStyleValue(overrideCameraHeight)
    const cappedLighting = capStyleValue(overrideLighting)
    const cappedColorGrading = capStyleValue(overrideColorGrading)
    const cappedStyle = capStyleValue(overrideStyle)
    if (cappedLens) mergedSettings.lens = cappedLens
    if (cappedCameraHeight) mergedSettings.camera_height = cappedCameraHeight
    if (cappedLighting) mergedSettings.lighting = cappedLighting
    if (cappedColorGrading) mergedSettings.color_grading = cappedColorGrading
    if (cappedStyle) mergedSettings.style = cappedStyle

    let userPrompt = prompt_text as string
    if (source_image_id) {
      userPrompt = `Using the provided source image as a base, recreate it with the following modifications: ${prompt_text}. Keep the rest of the image as close to the original as possible.`
    }

    const groups: ReferenceGroup[] = parsedRefSets.map((ps, i) => ({
      role: ps.role,
      count: finalCounts[i],
      label: ps.subject_label,
    }))
    const finalPrompt = buildFullPrompt(userPrompt, mergedSettings, groups)

    const { data: job, error: jobError } = await supabase
      .from(T.generation_jobs)
      .insert({
        product_id: productId,
        prompt_template_id,
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

    if (parsedRefSets.length > 0) {
      const joinRows = parsedRefSets.map((ps, i) => ({
        job_id: job.id,
        reference_set_id: ps.reference_set_id,
        role: ps.role,
        display_order: i,
        image_count: finalCounts[i],
        selected_image_ids: finalSelectedIds[i],
        subject_label: ps.subject_label,
      }))
      const { error: joinError } = await supabase
        .from(T.generation_job_reference_sets)
        .insert(joinRows)

      if (joinError) {
        await supabase.from(T.generation_jobs).delete().eq('id', job.id)
        return NextResponse.json({ error: 'Failed to attach reference sets to job' }, { status: 500 })
      }
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
      void processGenerationJob(job.id, { batchSize: finalBatch, parallelism: finalParallel, timeBudgetMs: finalBudget }).catch(async (err) => {
        const message = err instanceof Error ? err.message : 'Inline generation job failed'
        log.error('Inline job failed:', err)
        await logError({
          productId,
          errorMessage: message,
          errorSource: 'api/products/generate:inline',
          errorContext: { jobId: job.id },
        })
      })
    } else {
      kickWorkerForJob(job.id, request.url, '[Generate]', {
        batch: process.env.GENERATION_BATCH_SIZE ?? '',
        parallel: process.env.GENERATION_PARALLELISM ?? '',
        budget: process.env.GENERATION_TIME_BUDGET_MS ?? '',
      })
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    log.error('Error:', err)
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

    if (!isValidDeleteScope(scope)) {
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
        log.error('DELETE cancel', error)
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
        log.error('DELETE failed', error)
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
        log.error('DELETE log', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      clearedLog = data?.length || 0
    }

    return NextResponse.json({ cancelled, cleared_failed: clearedFailed, cleared_log: clearedLog })
  } catch (err) {
    log.error('DELETE', err)
    await logError({
      productId,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/products/generate:DELETE',
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
