import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { parseRequestBody } from '@/lib/request-guards'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { MAX_USER_PROMPT_LEN, SCENE_TITLE_SYSTEM_PROMPT, safeTextFromContent } from '@/lib/prompt-builder'
import { logger } from '@/lib/logger'

const anthropic = new Anthropic()

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
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

    const scene_title = safeTextFromContent(response.content).trim()

    return NextResponse.json({ scene_title })
  } catch (err) {
    // Log the full error internally but never echo raw error messages back to
    // the client — they can contain API keys or internal query details.
    logger.error('[scene-title] Error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
