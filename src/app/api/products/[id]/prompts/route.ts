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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.prompt_templates)
      .select('*')
      .eq('product_id', id)
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: product_id } = await params
    const supabase = createServiceClient()
    const body = await request.json()
    const { name, prompt_text, tags, prompt_type } = body

    if (!name || !prompt_text) {
      return NextResponse.json({ error: 'name and prompt_text are required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.prompt_templates)
      .insert({
        product_id,
        name,
        prompt_text,
        tags: tags ?? [],
        ...(prompt_type ? { prompt_type } : {}),
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Generate scene title asynchronously then update
    const sceneTitle = await generateSceneTitle(prompt_text)
    if (sceneTitle) {
      const { data: updated } = await supabase
        .from(T.prompt_templates)
        .update({ scene_title: sceneTitle })
        .eq('id', data.id)
        .select()
        .single()
      if (updated) return NextResponse.json(updated, { status: 201 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
