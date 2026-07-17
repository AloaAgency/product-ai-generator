import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, MAX_LIST_ROWS } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

const MAX_NAME_LENGTH = 500

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.settings_templates)
      .select('*')
      .eq('product_id', id)
      .order('created_at', { ascending: true })
      .limit(MAX_LIST_ROWS)

    if (error) { logger.error('[SettingsTemplates GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[SettingsTemplates GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: product_id } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const { name, settings } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return NextResponse.json({ error: 'settings must be an object' }, { status: 400 })
    }

    // Check if first template — auto-activate
    const { count, error: countError } = await supabase
      .from(T.settings_templates)
      .select('*', { count: 'exact', head: true })
      .eq('product_id', product_id)

    if (countError) { logger.error('[SettingsTemplates POST count]', countError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    const isFirst = (count ?? 0) === 0

    const { data, error } = await supabase
      .from(T.settings_templates)
      .insert({
        product_id,
        name,
        settings: settings ?? {},
        is_active: isFirst,
      })
      .select()
      .single()

    if (error) { logger.error('[SettingsTemplates POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    // If first template, sync settings to product
    if (isFirst && settings) {
      const { error: syncError } = await supabase
        .from(T.products)
        .update({ global_style_settings: settings })
        .eq('id', product_id)
      if (syncError) {
        logger.error('[SettingsTemplates POST] Failed to sync settings to product:', syncError)
      }
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logger.error('[SettingsTemplates POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
