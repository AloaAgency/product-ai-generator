import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'

const anthropic = new Anthropic()

async function generateSceneTitle(promptText: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 50,
      system: 'Generate a short (3-6 word) descriptive title for this product photography scene. Output ONLY the title.',
      messages: [{ role: 'user', content: promptText }],
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
    const body = await request.json()

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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
