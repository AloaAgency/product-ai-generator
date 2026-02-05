import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

type Params = { params: Promise<{ id: string; sceneId: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { sceneId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    const normalizeDuration = (model: string, value: unknown) => {
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) return null
      if (model.toLowerCase().startsWith('ltx')) return parsed
      const allowed = [4, 6, 8]
      if (allowed.includes(parsed)) return parsed
      return allowed.reduce((closest, current) => {
        const currentDiff = Math.abs(current - parsed)
        const closestDiff = Math.abs(closest - parsed)
        if (currentDiff < closestDiff) return current
        if (currentDiff === closestDiff && current > closest) return current
        return closest
      }, allowed[0])
    }

    let modelForDuration = typeof body.generation_model === 'string'
      ? body.generation_model
      : null

    if (body.video_duration_seconds !== undefined && !modelForDuration) {
      const { data: scene } = await supabase
        .from(T.storyboard_scenes)
        .select('generation_model')
        .eq('id', sceneId)
        .single()
      modelForDuration = scene?.generation_model || 'veo3'
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (body.title !== undefined) updates.title = body.title
    if (body.prompt_text !== undefined) updates.prompt_text = body.prompt_text
    if (body.end_frame_prompt !== undefined) updates.end_frame_prompt = body.end_frame_prompt
    if (body.motion_prompt !== undefined) updates.motion_prompt = body.motion_prompt
    if (body.generation_model !== undefined) updates.generation_model = body.generation_model
    if (body.paired !== undefined) updates.paired = body.paired
    if (body.scene_order !== undefined) updates.scene_order = body.scene_order
    if (body.storyboard_id !== undefined) updates.storyboard_id = body.storyboard_id
    if (body.start_frame_image_id !== undefined) updates.start_frame_image_id = body.start_frame_image_id
    if (body.end_frame_image_id !== undefined) updates.end_frame_image_id = body.end_frame_image_id
    if (body.video_resolution !== undefined) updates.video_resolution = body.video_resolution
    if (body.video_aspect_ratio !== undefined) updates.video_aspect_ratio = body.video_aspect_ratio
    if (body.video_duration_seconds !== undefined && modelForDuration) {
      updates.video_duration_seconds = normalizeDuration(modelForDuration, body.video_duration_seconds)
    }
    if (body.video_fps !== undefined) updates.video_fps = body.video_fps
    if (body.video_generate_audio !== undefined) updates.video_generate_audio = body.video_generate_audio

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

export async function DELETE(_request: NextRequest, { params }: Params) {
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
