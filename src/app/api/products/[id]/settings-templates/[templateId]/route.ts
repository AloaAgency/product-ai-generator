import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/logger'

// Must match the limit enforced by the POST route on the same table
const MAX_NAME_LENGTH = 500

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; templateId: string }> }
) {
  try {
    const { id: productId, templateId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.name === 'string' && body.name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (body.settings !== undefined && body.settings !== null && (typeof body.settings !== 'object' || Array.isArray(body.settings))) {
      return NextResponse.json({ error: 'settings must be an object' }, { status: 400 })
    }
    if (body.name === undefined && body.settings === undefined && body.is_active === undefined) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    // If activating, deactivate others first
    if (body.is_active === true) {
      const { error: deactivateError } = await supabase
        .from(T.settings_templates)
        .update({ is_active: false })
        .eq('product_id', productId)

      if (deactivateError) { logger.error('[SettingsTemplate PATCH deactivate]', deactivateError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
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

    if (error) { logger.error('[SettingsTemplate PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    // When activating, sync settings to product
    if (body.is_active === true) {
      const settingsToSync = body.settings ?? data.settings
      await supabase
        .from(T.products)
        .update({ global_style_settings: settingsToSync })
        .eq('id', productId)
    }

    return NextResponse.json(data)
  } catch (err) {
    logger.error('[SettingsTemplate PATCH] Unexpected error:', err)
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

    if (error) { logger.error('[SettingsTemplate DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[SettingsTemplate DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
