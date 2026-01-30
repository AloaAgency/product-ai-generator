import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productId } = await params
    const { searchParams } = request.nextUrl
    const storyboardId = searchParams.get('storyboard_id')
    const supabase = createServiceClient()

    let query = supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })

    if (storyboardId) {
      query = query.eq('storyboard_id', storyboardId)
    }

    const { data, error } = await query
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
    const { id: productId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    const insert: Record<string, unknown> = {
      product_id: productId,
      title: body.title || null,
      prompt_text: body.prompt_text || null,
      end_frame_prompt: body.end_frame_prompt || null,
      motion_prompt: body.motion_prompt || null,
      generation_model: body.generation_model || 'veo3',
      paired: body.paired ?? false,
    }
    if (body.start_frame_image_id !== undefined) insert.start_frame_image_id = body.start_frame_image_id
    if (body.end_frame_image_id !== undefined) insert.end_frame_image_id = body.end_frame_image_id
    if (body.video_resolution !== undefined) insert.video_resolution = body.video_resolution
    if (body.video_aspect_ratio !== undefined) insert.video_aspect_ratio = body.video_aspect_ratio
    if (body.video_duration_seconds !== undefined) insert.video_duration_seconds = body.video_duration_seconds
    if (body.video_fps !== undefined) insert.video_fps = body.video_fps
    if (body.video_generate_audio !== undefined) insert.video_generate_audio = body.video_generate_audio

    // Optionally attach to a storyboard
    if (body.storyboard_id) {
      insert.storyboard_id = body.storyboard_id
      insert.scene_order = body.scene_order ?? 0
    }

    const { data, error } = await supabase
      .from(T.storyboard_scenes)
      .insert(insert)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
