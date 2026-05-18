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

    if (error) { console.error('[StoryboardScenes GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
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
    const { id: productId, boardId } = await params
    const supabase = createServiceClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }

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
        product_id: productId,
        storyboard_id: boardId,
        scene_order: nextOrder,
        title: body.title || null,
        prompt_text: body.prompt_text || null,
        end_frame_prompt: body.end_frame_prompt || null,
        paired: body.paired ?? false,
      })
      .select()
      .single()

    if (error) { console.error('[StoryboardScenes POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
