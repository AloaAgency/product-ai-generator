import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, isUuid, MAX_LIST_ROWS } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

const MAX_NAME_LENGTH = 500
const MAX_STORYBOARD_IMAGES = 200

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
      .limit(MAX_LIST_ROWS)

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

    if (!name || typeof name !== 'string' || !Array.isArray(image_ids) || image_ids.length === 0) {
      return NextResponse.json(
        { error: 'name and image_ids are required' },
        { status: 400 }
      )
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (image_ids.length > MAX_STORYBOARD_IMAGES) {
      return NextResponse.json({ error: `image_ids cannot contain more than ${MAX_STORYBOARD_IMAGES} entries` }, { status: 400 })
    }
    if (!image_ids.every((value) => typeof value === 'string' && isUuid(value))) {
      return NextResponse.json({ error: 'image_ids must be an array of image UUIDs' }, { status: 400 })
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
