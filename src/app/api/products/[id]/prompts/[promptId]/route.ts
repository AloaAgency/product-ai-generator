import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { SCENE_TITLE_SYSTEM_PROMPT, MAX_USER_PROMPT_LEN } from '@/lib/prompt-builder'

const anthropic = new Anthropic()

// Must match the limits enforced by the POST route on the same table
const MAX_NAME_LENGTH = 500
const MAX_PROMPT_LENGTH = 10000

async function generateSceneTitle(promptText: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 50,
      system: SCENE_TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: promptText.slice(0, MAX_USER_PROMPT_LEN) }],
    })
    return response.content[0].type === 'text' ? response.content[0].text.trim() : ''
  } catch {
    return ''
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; promptId: string }> }
) {
  try {
    const { id: productId, promptId } = await params
    const supabase = createServiceClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }

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

    if (error) { console.error('[Prompt PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch {
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

    if (error) { console.error('[Prompt DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
