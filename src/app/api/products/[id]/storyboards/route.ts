import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/logger'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.storyboards)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: true })

    if (error) { logger.error('[Storyboards GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data || [])
  } catch (err) {
    logger.error('[Storyboards GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const { name, image_ids } = body

    if (!name || !Array.isArray(image_ids) || image_ids.length === 0) {
      return NextResponse.json(
        { error: 'name and image_ids are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from(T.storyboards)
      .insert({
        product_id: productId,
        name,
        image_ids,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) { logger.error('[Storyboards POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logger.error('[Storyboards POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
