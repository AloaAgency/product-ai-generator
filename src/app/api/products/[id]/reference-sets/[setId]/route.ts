import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }

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

      if (deactivateError) { console.error('[ReferenceSet PATCH deactivate]', deactivateError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
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

    if (error) { console.error('[ReferenceSet PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch {
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

    if (error) { console.error('[ReferenceSet DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
