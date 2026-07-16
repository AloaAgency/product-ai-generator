import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { normalizeDurationValue } from '@/lib/video-constants'
import { parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

// Must match the limits enforced by POST /api/products/[id]/scenes on the same table
const MAX_PROMPT_LENGTH = 10000
const MAX_TITLE_LENGTH = 500

type Params = { params: Promise<{ id: string; sceneId: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { sceneId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.title === 'string' && body.title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` }, { status: 400 })
    }
    for (const field of ['prompt_text', 'end_frame_prompt', 'motion_prompt'] as const) {
      if (typeof body[field] === 'string' && (body[field] as string).length > MAX_PROMPT_LENGTH) {
        return NextResponse.json({ error: `${field} must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 })
      }
    }

    // Fetch existing scene to resolve model, resolution, and frame info for duration normalization
    let existingScene: { generation_model?: string; video_resolution?: string; start_frame_image_id?: string; end_frame_image_id?: string } | null = null
    const needsExistingScene = body.video_duration_seconds !== undefined || body.video_resolution !== undefined || body.start_frame_image_id !== undefined || body.end_frame_image_id !== undefined
    if (needsExistingScene) {
      const { data: scene } = await supabase
        .from(T.storyboard_scenes)
        .select('generation_model, video_resolution, start_frame_image_id, end_frame_image_id')
        .eq('id', sceneId)
        .single()
      existingScene = scene
    }

    const modelForDuration = typeof body.generation_model === 'string'
      ? body.generation_model
      : existingScene?.generation_model || 'veo3'
    const resolutionForDuration = (body.video_resolution !== undefined ? body.video_resolution : existingScene?.video_resolution) as string | null | undefined
    const hasStartFrame = body.start_frame_image_id !== undefined ? !!body.start_frame_image_id : !!existingScene?.start_frame_image_id
    const hasEndFrame = body.end_frame_image_id !== undefined ? !!body.end_frame_image_id : !!existingScene?.end_frame_image_id

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
    if (body.video_duration_seconds !== undefined) {
      updates.video_duration_seconds = normalizeDurationValue(modelForDuration, body.video_duration_seconds, resolutionForDuration, hasStartFrame, hasEndFrame)
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
  } catch (err) {
    logger.error('[Scene PATCH] Unexpected error:', err)
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

    if (error) { logger.error('[Scene DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[Scene DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
