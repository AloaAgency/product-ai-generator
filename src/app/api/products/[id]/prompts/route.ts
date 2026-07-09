import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { generateSceneTitle } from '@/lib/prompt-builder'
import { parseRequestBody, MAX_LIST_ROWS } from '@/lib/request-guards'
import { logger } from '@/lib/logger'

const MAX_NAME_LENGTH = 500
const MAX_PROMPT_LENGTH = 10000

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
      .limit(MAX_LIST_ROWS)

    if (error) { logger.error('[Prompts GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Prompts GET] Unexpected error:', err instanceof Error ? err.message : String(err))
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
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const { name, prompt_text, tags, prompt_type } = body

    if (!name || !prompt_text) {
      return NextResponse.json({ error: 'name and prompt_text are required' }, { status: 400 })
    }
    // Type-check before the length checks — the PATCH route on this table
    // enforces string-only name/prompt_text, and skipping the check here would
    // let a non-string (number/array/object) bypass the length limits entirely
    // and reach the insert below.
    if (typeof name !== 'string' || typeof prompt_text !== 'string') {
      return NextResponse.json({ error: 'name and prompt_text must be strings' }, { status: 400 })
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (prompt_text.length > MAX_PROMPT_LENGTH) {
      return NextResponse.json({ error: `prompt_text must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 })
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

    if (error) { logger.error('[Prompts POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

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
    logger.error('[Prompts POST] Unexpected error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
