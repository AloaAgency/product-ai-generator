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
      .from(T.reference_sets)
      .select('*')
      .eq('product_id', id)
      .order('display_order', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
    const body = await request.json()
    const { name, description, type = 'product' } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
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

    if (countError) return NextResponse.json({ error: countError.message }, { status: 500 })

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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
