import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.name === 'string' && body.name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof body.description === 'string' && body.description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (body.name === undefined && body.description === undefined && body.is_active === undefined) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    // If setting is_active=true, deactivate other sets first
    if (body.is_active === true) {
      const { data: setRecord, error: setError } = await supabase
        .from(T.reference_sets)
        .select('type')
        .eq('id', setId)
        .eq('product_id', productId)
        .single()

      if (setError || !setRecord) {
        return NextResponse.json({ error: 'Reference set not found' }, { status: 404 })
      }

      if (setRecord.type === 'texture') {
        return NextResponse.json({ error: 'Texture sets cannot be active' }, { status: 400 })
      }

      const { error: deactivateError } = await supabase
        .from(T.reference_sets)
        .update({ is_active: false })
        .eq('product_id', productId)
        .eq('type', 'product')

      if (deactivateError) { logger.error('[ReferenceSet PATCH deactivate]', deactivateError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description
    if (body.is_active !== undefined) updates.is_active = body.is_active

    const { data, error } = await supabase
      .from(T.reference_sets)
      .update(updates)
      .eq('id', setId)
      .eq('product_id', productId)
      .select()
      .single()

    if (error) { logger.error('[ReferenceSet PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[ReferenceSet PATCH] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.reference_sets)
      .delete()
      .eq('id', setId)
      .eq('product_id', productId)

    if (error) { logger.error('[ReferenceSet DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[ReferenceSet DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
