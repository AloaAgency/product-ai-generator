import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; templateId: string }> }
) {
  try {
    const { id: productId, templateId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    // If activating, deactivate others first
    if (body.is_active === true) {
      const { error: deactivateError } = await supabase
        .from(T.settings_templates)
        .update({ is_active: false })
        .eq('product_id', productId)

      if (deactivateError) return NextResponse.json({ error: deactivateError.message }, { status: 500 })
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.settings !== undefined) updates.settings = body.settings
    if (body.is_active !== undefined) updates.is_active = body.is_active
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from(T.settings_templates)
      .update(updates)
      .eq('id', templateId)
      .eq('product_id', productId)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // When activating, sync settings to product
    if (body.is_active === true) {
      const settingsToSync = body.settings ?? data.settings
      await supabase
        .from(T.products)
        .update({ global_style_settings: settingsToSync })
        .eq('id', productId)
    }

    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; templateId: string }> }
) {
  try {
    const { id: productId, templateId } = await params
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.settings_templates)
      .delete()
      .eq('id', templateId)
      .eq('product_id', productId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
