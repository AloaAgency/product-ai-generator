import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { generateSceneTitle } from '@/lib/prompt-builder'
import { parseRequestBody } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

// Must match the limits enforced by the POST route on the same table
const MAX_NAME_LENGTH = 500
const MAX_PROMPT_LENGTH = 10000

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; promptId: string }> }
) {
  try {
    const { id: productId, promptId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
      }
      if (body.name.length > MAX_NAME_LENGTH) {
        return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
      }
    }
    if (body.prompt_text !== undefined) {
      if (typeof body.prompt_text !== 'string' || body.prompt_text.trim().length === 0) {
        return NextResponse.json({ error: 'prompt_text must be a non-empty string' }, { status: 400 })
      }
      if (body.prompt_text.length > MAX_PROMPT_LENGTH) {
        return NextResponse.json({ error: `prompt_text must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 })
      }
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.prompt_text !== undefined) updates.prompt_text = body.prompt_text
    if (body.tags !== undefined) updates.tags = body.tags

    // Regenerate scene title if prompt_text changed
    if (body.prompt_text !== undefined) {
      const sceneTitle = await generateSceneTitle(body.prompt_text)
      if (sceneTitle) updates.scene_title = sceneTitle
    }

    const { data, error } = await supabase
      .from(T.prompt_templates)
      .update(updates)
      .eq('id', promptId)
      .eq('product_id', productId)
      .select()
      .single()

    if (error) { logger.error('[Prompt PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Prompt PATCH] Unexpected error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; promptId: string }> }
) {
  try {
    const { id: productId, promptId } = await params
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.prompt_templates)
      .delete()
      .eq('id', promptId)
      .eq('product_id', productId)

    if (error) { logger.error('[Prompt DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[Prompt DELETE] Unexpected error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
