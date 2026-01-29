import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { buildFullPrompt } from '@/lib/prompt-builder'
import type { Product, ReferenceSet, ReferenceImage } from '@/lib/types'
import { T } from '@/lib/db-tables'
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

    const shouldRunInline =
      process.env.INLINE_GENERATION === 'true' || process.env.NODE_ENV === 'development'

    if (shouldRunInline) {
      void processGenerationJob(job.id, { batchSize: variation_count })
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
