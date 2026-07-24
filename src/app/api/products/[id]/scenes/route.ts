import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { normalizeDurationValue } from '@/lib/video-constants'
import {
  optionalUuid,
  parseRequestBody,
  requireUuid,
  MAX_LIST_ROWS,
  MAX_PROMPT_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawProductId } = await params
    const { searchParams } = request.nextUrl
    let productId: string
    let storyboardId: string | undefined
    try {
      productId = requireUuid(rawProductId, 'product id')
      storyboardId = optionalUuid(searchParams.get('storyboard_id'), 'storyboard id')
    } catch {
      return NextResponse.json({ error: 'Invalid scene query' }, { status: 400 })
    }
    const supabase = createServiceClient()

    let query = supabase
      .from(T.storyboard_scenes)
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(MAX_LIST_ROWS)

    if (storyboardId) {
      query = query.eq('storyboard_id', storyboardId)
    }

    const { data, error } = await query
    if (error) { logger.error('[Scenes GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Scenes GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawProductId } = await params
    let productId: string
    try {
      productId = requireUuid(rawProductId, 'product id')
    } catch {
      return NextResponse.json({ error: 'Invalid product id' }, { status: 400 })
    }
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    for (const [field, maxLength] of [
      ['title', MAX_TITLE_LENGTH],
      ['prompt_text', MAX_PROMPT_TEXT_LENGTH],
      ['end_frame_prompt', MAX_PROMPT_TEXT_LENGTH],
      ['motion_prompt', MAX_PROMPT_TEXT_LENGTH],
    ] as const) {
      const value = body[field]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return NextResponse.json({ error: `${field} must be a string` }, { status: 400 })
      }
      if (typeof value === 'string' && value.length > maxLength) {
        return NextResponse.json({ error: `${field} must be ${maxLength} characters or fewer` }, { status: 400 })
      }
    }

    for (const field of ['generation_model', 'video_resolution', 'video_aspect_ratio'] as const) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
        return NextResponse.json({ error: `${field} must be a string` }, { status: 400 })
      }
    }

    if (body.paired !== undefined && typeof body.paired !== 'boolean') {
      return NextResponse.json({ error: 'paired must be a boolean' }, { status: 400 })
    }

    for (const field of ['start_frame_image_id', 'end_frame_image_id', 'storyboard_id'] as const) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
        return NextResponse.json({ error: `${field} must be a UUID string` }, { status: 400 })
      }
    }

    for (const field of ['video_duration_seconds', 'video_fps', 'scene_order'] as const) {
      if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]))) {
        return NextResponse.json({ error: `${field} must be a finite number` }, { status: 400 })
      }
    }

    if (body.video_generate_audio !== undefined && typeof body.video_generate_audio !== 'boolean') {
      return NextResponse.json({ error: 'video_generate_audio must be a boolean' }, { status: 400 })
    }

    let startFrameImageId: string | undefined
    let endFrameImageId: string | undefined
    let storyboardId: string | undefined
    try {
      startFrameImageId = optionalUuid(body.start_frame_image_id as string | null | undefined, 'start frame image id')
      endFrameImageId = optionalUuid(body.end_frame_image_id as string | null | undefined, 'end frame image id')
      storyboardId = optionalUuid(body.storyboard_id as string | null | undefined, 'storyboard id')
    } catch {
      return NextResponse.json({ error: 'Invalid scene reference id' }, { status: 400 })
    }

    const frameImageIds = Array.from(new Set([startFrameImageId, endFrameImageId].filter((id): id is string => Boolean(id))))
    if (frameImageIds.length > 0) {
      const { data: ownedFrames, error: framesError } = await supabase
        .from(T.generated_images)
        .select('id')
        .eq('product_id', productId)
        .in('id', frameImageIds)

      if (framesError) {
        logger.error('[Scenes POST] Frame ownership lookup failed', framesError)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      if (new Set((ownedFrames ?? []).map((frame) => frame.id)).size !== frameImageIds.length) {
        return NextResponse.json({ error: 'Frame images must belong to the selected product' }, { status: 400 })
      }
    }

    if (storyboardId) {
      const { data: storyboard, error: storyboardError } = await supabase
        .from(T.storyboards)
        .select('id')
        .eq('id', storyboardId)
        .eq('product_id', productId)
        .maybeSingle()

      if (storyboardError) {
        logger.error('[Scenes POST] Storyboard ownership lookup failed', storyboardError)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      if (!storyboard) {
        return NextResponse.json({ error: 'Storyboard must belong to the selected product' }, { status: 400 })
      }
    }

    const model = (body.generation_model as string | undefined) || 'veo3'

    const insert: Record<string, unknown> = {
      product_id: productId,
      title: body.title || null,
      prompt_text: body.prompt_text || null,
      end_frame_prompt: body.end_frame_prompt || null,
      motion_prompt: body.motion_prompt || null,
      generation_model: model,
      paired: body.paired ?? false,
    }
    if (body.start_frame_image_id !== undefined) insert.start_frame_image_id = startFrameImageId ?? null
    if (body.end_frame_image_id !== undefined) insert.end_frame_image_id = endFrameImageId ?? null
    if (body.video_resolution !== undefined) insert.video_resolution = body.video_resolution
    if (body.video_aspect_ratio !== undefined) insert.video_aspect_ratio = body.video_aspect_ratio
    if (body.video_duration_seconds !== undefined) {
      insert.video_duration_seconds = normalizeDurationValue(model, body.video_duration_seconds, body.video_resolution as string | null | undefined, !!body.start_frame_image_id, !!body.end_frame_image_id)
    }
    if (body.video_fps !== undefined) insert.video_fps = body.video_fps
    if (body.video_generate_audio !== undefined) insert.video_generate_audio = body.video_generate_audio

    // Optionally attach to a storyboard
    if (storyboardId) {
      insert.storyboard_id = storyboardId
      insert.scene_order = body.scene_order ?? 0
    }

    const { data, error } = await supabase
      .from(T.storyboard_scenes)
      .insert(insert)
      .select()
      .single()

    if (error) { logger.error('[Scenes POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logger.error('[Scenes POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
