import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string }> }
) {
  try {
    const { id: productId, boardId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
