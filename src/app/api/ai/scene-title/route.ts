import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { MAX_USER_PROMPT_LEN, SCENE_TITLE_SYSTEM_PROMPT } from '@/lib/prompt-builder'

const anthropic = new Anthropic()

export async function POST(request: NextRequest) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }
    const rawPrompt = body?.prompt_text

    if (!rawPrompt) {
      return NextResponse.json({ error: 'prompt_text is required' }, { status: 400 })
    }

    // Truncate to prevent oversized payloads from abusing API costs
    const prompt_text = String(rawPrompt).slice(0, MAX_USER_PROMPT_LEN)

    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 50,
      system: SCENE_TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt_text }],
    })

    const scene_title = response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : ''

    return NextResponse.json({ scene_title })
  } catch (err) {
    // Log the full error internally but never echo raw error messages back to
    // the client — they can contain API keys or internal query details.
    console.error('[scene-title] Error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
