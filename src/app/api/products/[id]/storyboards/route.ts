import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.storyboards)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data || [])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()
    const body = await request.json()
    const { name, image_ids } = body

    if (!name || !Array.isArray(image_ids) || image_ids.length === 0) {
      return NextResponse.json(
        { error: 'name and image_ids are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from(T.storyboards)
      .insert({
        product_id: productId,
        name,
        image_ids,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
