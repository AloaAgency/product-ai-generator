import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { createAnthropicClient } from '@/lib/anthropic-client'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import {
  buildPromptSuggestionSystemPrompt,
  parsePromptSuggestions,
  safeTextFromContent,
  validateSuggestionCount,
  MAX_SUGGESTION_COUNT,
} from '@/lib/prompt-builder'
import { parseRequestBody } from '@/lib/request-guards'
import type { GlobalStyleSettings } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'
import { logger } from '@/lib/server-logger'

const anthropic = createAnthropicClient()

export async function POST(request: NextRequest) {
  let product_id: string | undefined

  // parseRequestBody rejects non-object bodies (null/array/primitive) with a 400
  // instead of letting a later `body.product_id` access throw into the 500 catch.
  const parsed = await parseRequestBody<{ product_id?: string; count?: number }>(request)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  try {
    product_id = body.product_id

    // Validate count: must be a finite integer in [1, MAX_SUGGESTION_COUNT].
    // Passing a non-numeric value (NaN, string, undefined) would otherwise
    // propagate as NaN into the system prompt, producing "exactly NaN unique…".
    const count = validateSuggestionCount(body.count ?? 5)
    if (count === null) {
      return NextResponse.json(
        { error: `count must be an integer between 1 and ${MAX_SUGGESTION_COUNT}` },
        { status: 400 }
      )
    }

    if (!product_id) {
      return NextResponse.json(
        { error: 'product_id is required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Single JOIN query — fetches product + parent project in one round-trip.
    // Only the columns this route actually reads: name/description feed the
    // system prompt, the two style blobs feed mergeStyles.
    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select(`name,description,global_style_settings,${T.projects}!fk_products_project(global_style_settings)`)
      .eq('id', product_id)
      .single<{
        name: string
        description: string | null
        global_style_settings: GlobalStyleSettings | null
        prodai_projects: { global_style_settings: GlobalStyleSettings | null } | null
      }>()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const projectStyles = product.prodai_projects?.global_style_settings ?? {}
    const mergedSettings = mergeStyles(projectStyles, product.global_style_settings ?? undefined)

    const systemPrompt = buildPromptSuggestionSystemPrompt(
      product.name,
      product.description,
      mergedSettings,
      count
    )

    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Generate ${count} unique product image prompt ideas.`,
        },
      ],
    })

    const text = safeTextFromContent(response.content)

    const prompts = parsePromptSuggestions(text)

    return NextResponse.json({ prompts })
  } catch (err) {
    // Log the full error internally but never echo raw error messages back to
    // the client — they can contain API keys or internal query details.
    logger.error('[SuggestPrompts] Error:', err instanceof Error ? err.message : String(err))
    await logError({
      productId: product_id,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/ai/suggest-prompts',
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
