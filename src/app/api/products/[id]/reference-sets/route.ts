import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const MAX_NAME_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 5000

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.reference_sets)
      .select('*')
      .eq('product_id', id)
      .order('display_order', { ascending: true })

    if (error) { console.error('[ReferenceSets GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
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
    const { name, description, type = 'product' } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (typeof name === 'string' && name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` }, { status: 400 })
    }

    if (type !== 'product' && type !== 'texture') {
      return NextResponse.json({ error: 'type must be "product" or "texture"' }, { status: 400 })
    }

    // Check if this is the first set of this type for the product
    const { count, error: countError } = await supabase
      .from(T.reference_sets)
      .select('*', { count: 'exact', head: true })
      .eq('product_id', product_id)
      .eq('type', type)

    if (countError) { console.error('[ReferenceSets POST count]', countError); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    // Only auto-activate for product sets (not texture sets)
    const isFirst = (count ?? 0) === 0 && type === 'product'

    const { data, error } = await supabase
      .from(T.reference_sets)
      .insert({
        product_id,
        name,
        description: description ?? null,
        type,
        is_active: isFirst,
        display_order: (count ?? 0),
      })
      .select()
      .single()

    if (error) { console.error('[ReferenceSets POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
