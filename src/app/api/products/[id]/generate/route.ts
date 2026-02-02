import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import type { Product, Project, ReferenceSet, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { processGenerationJob } from '@/lib/generation-worker'

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
      parallelism_override,
      batch_override,
      time_budget_ms_override,
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

    // Fetch parent project and merge styles
    const typedProduct = product as Product
    let projectStyles = {}
    if (typedProduct.project_id) {
      const { data: project } = await supabase
        .from(T.projects)
        .select('*')
        .eq('id', typedProduct.project_id)
        .single()
      if (project) {
        projectStyles = (project as Project).global_style_settings ?? {}
      }
    }
    const mergedSettings = mergeStyles(projectStyles, typedProduct.global_style_settings)

    // Build final prompt
    const finalPrompt = buildFullPrompt(
      prompt_text,
      mergedSettings,
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
        job_type: 'image',
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
        : variation_count || 1
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
      const cronSecret = process.env.CRON_SECRET
      if (cronSecret) {
        const url = new URL('/api/worker/generate', request.url)
        url.searchParams.set('jobId', job.id)
        const batchSize = process.env.GENERATION_BATCH_SIZE
        const parallelism = process.env.GENERATION_PARALLELISM
        const budget = process.env.GENERATION_TIME_BUDGET_MS
        if (batchSize) url.searchParams.set('batch', batchSize)
        if (parallelism) url.searchParams.set('parallel', parallelism)
        if (budget) url.searchParams.set('budget', budget)

        void (async () => {
          try {
            const res = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${cronSecret}`,
              },
            })
            console.log('[Generate] Worker kick', {
              jobId: job.id,
              status: res.status,
            })
          } catch (err) {
            console.warn('[Generate] Worker kick failed', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    console.error('[Generate] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from(T.generation_jobs)
      .update({
        status: 'cancelled',
        error_message: 'Cancelled by user',
        completed_at: new Date().toISOString(),
      })
      .eq('product_id', productId)
      .in('status', ['pending', 'running'])
      .select('id')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ cancelled: data?.length || 0 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
