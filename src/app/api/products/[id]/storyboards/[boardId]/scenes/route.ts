import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, MAX_LIST_ROWS, MAX_PROMPT_TEXT_LENGTH, MAX_TITLE_LENGTH } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

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
      .limit(MAX_LIST_ROWS)

    if (error) { logger.error('[StoryboardScenes GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data || [])
  } catch (err) {
    logger.error('[StoryboardScenes GET] Unexpected error:', err)
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
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.title === 'string' && body.title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof body.prompt_text === 'string' && body.prompt_text.length > MAX_PROMPT_TEXT_LENGTH) {
      return NextResponse.json({ error: `prompt_text must be ${MAX_PROMPT_TEXT_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof body.end_frame_prompt === 'string' && body.end_frame_prompt.length > MAX_PROMPT_TEXT_LENGTH) {
      return NextResponse.json({ error: `end_frame_prompt must be ${MAX_PROMPT_TEXT_LENGTH} characters or fewer` }, { status: 400 })
    }

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

    if (error) { logger.error('[StoryboardScenes POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logger.error('[StoryboardScenes POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
