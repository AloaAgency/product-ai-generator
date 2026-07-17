import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, isUuid } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

// Must match the limits enforced by the POST route on the same table
const MAX_NAME_LENGTH = 500
const MAX_STORYBOARD_IMAGES = 200

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string }> }
) {
  try {
    const { id: productId, boardId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.name === 'string' && body.name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (body.image_ids !== undefined) {
      if (!Array.isArray(body.image_ids) || body.image_ids.length === 0) {
        return NextResponse.json({ error: 'image_ids must be a non-empty array' }, { status: 400 })
      }
      if (body.image_ids.length > MAX_STORYBOARD_IMAGES) {
        return NextResponse.json({ error: `image_ids cannot contain more than ${MAX_STORYBOARD_IMAGES} entries` }, { status: 400 })
      }
      if (!body.image_ids.every((value) => typeof value === 'string' && isUuid(value))) {
        return NextResponse.json({ error: 'image_ids must be an array of image UUIDs' }, { status: 400 })
      }
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (body.name !== undefined) updates.name = body.name
    if (body.image_ids !== undefined) updates.image_ids = body.image_ids

    if (Object.keys(updates).length === 1) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.storyboards)
      .update(updates)
      .eq('id', boardId)
      .eq('product_id', productId)
      .select()
      .single()

    if (error || !data) return NextResponse.json({ error: 'Storyboard not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Storyboard PATCH] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string }> }
) {
  try {
    const { id: productId, boardId } = await params
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.storyboards)
      .delete()
      .eq('id', boardId)
      .eq('product_id', productId)

    if (error) { logger.error('[Storyboard DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[Storyboard DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
