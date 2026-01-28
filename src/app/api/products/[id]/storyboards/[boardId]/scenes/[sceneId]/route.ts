import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  try {
    const { sceneId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (body.title !== undefined) updates.title = body.title
    if (body.prompt_text !== undefined) updates.prompt_text = body.prompt_text
    if (body.end_frame_prompt !== undefined) updates.end_frame_prompt = body.end_frame_prompt
    if (body.paired !== undefined) updates.paired = body.paired
    if (body.scene_order !== undefined) updates.scene_order = body.scene_order

    if (Object.keys(updates).length === 1) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.storyboard_scenes)
      .update(updates)
      .eq('id', sceneId)
      .select()
      .single()

    if (error || !data) return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; boardId: string; sceneId: string }> }
) {
  try {
    const { sceneId } = await params
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.storyboard_scenes)
      .delete()
      .eq('id', sceneId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
