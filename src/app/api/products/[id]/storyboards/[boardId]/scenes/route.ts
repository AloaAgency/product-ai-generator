import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string }> }
) {
  try {
    const { boardId } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('storyboard_id', boardId)
      .order('scene_order', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data || [])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string }> }
) {
  try {
    const { boardId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    // Determine next scene_order
    const { data: existing } = await supabase
      .from(T.storyboard_scenes)
      .select('scene_order')
      .eq('storyboard_id', boardId)
      .order('scene_order', { ascending: false })
      .limit(1)

    const nextOrder = existing && existing.length > 0 ? existing[0].scene_order + 1 : 0

    const { data, error } = await supabase
      .from(T.storyboard_scenes)
      .insert({
        storyboard_id: boardId,
        scene_order: nextOrder,
        title: body.title || null,
        prompt_text: body.prompt_text || null,
        end_frame_prompt: body.end_frame_prompt || null,
        paired: body.paired ?? false,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
