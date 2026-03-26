import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { MAX_USER_PROMPT_LEN } from '@/lib/prompt-builder'

const anthropic = new Anthropic()

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const rawPrompt = body?.prompt_text

    if (!rawPrompt) {
      return NextResponse.json({ error: 'prompt_text is required' }, { status: 400 })
    }

    // Truncate to prevent oversized payloads from abusing API costs
    const prompt_text = String(rawPrompt).slice(0, MAX_USER_PROMPT_LEN)

    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 50,
      system: 'Generate a short (3-6 word) descriptive title for this product photography scene. Output ONLY the title.',
      messages: [{ role: 'user', content: prompt_text }],
    })

    const scene_title = response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : ''

    return NextResponse.json({ scene_title })
  } catch (err) {
    console.error('[scene-title] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
