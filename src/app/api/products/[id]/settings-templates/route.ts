import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

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

    if (error) { console.error('[SettingsTemplates GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }
    const { name, settings } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    // Check if first template — auto-activate
    const { count, error: countError } = await supabase
      .from(T.settings_templates)
      .select('*', { count: 'exact', head: true })
      .eq('product_id', product_id)

    if (countError) { console.error('[SettingsTemplates POST count]', countError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

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

    if (error) { console.error('[SettingsTemplates POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    // If first template, sync settings to product
    if (isFirst && settings) {
      const { error: syncError } = await supabase
        .from(T.products)
        .update({ global_style_settings: settings })
        .eq('id', product_id)
      if (syncError) {
        console.error('[SettingsTemplates POST] Failed to sync settings to product:', syncError)
      }
    }

    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
