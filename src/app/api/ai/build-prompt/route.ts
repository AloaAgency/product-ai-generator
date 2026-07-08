import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { createAnthropicClient } from '@/lib/anthropic-client'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { buildRefinedPromptUserMessage, safeTextFromContent } from '@/lib/prompt-builder'
import { parseRequestBody } from '@/lib/request-guards'
import type { GlobalStyleSettings } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'
import { logger } from '@/lib/logger'

const anthropic = createAnthropicClient()

export async function POST(request: NextRequest) {
  let product_id: string | undefined

  // parseRequestBody rejects non-object bodies (null/array/primitive) with a 400
  // instead of letting a later `body.product_id` access throw into the 500 catch.
  const parsed = await parseRequestBody<{ product_id?: string; user_prompt?: string }>(request)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  try {
    product_id = body.product_id
    const user_prompt = body.user_prompt

    if (!product_id || !user_prompt) {
      return NextResponse.json(
        { error: 'product_id and user_prompt are required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Single JOIN query — fetches product + parent project in one round-trip
    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select(`id,name,description,project_id,global_style_settings,${T.projects}!fk_products_project(global_style_settings)`)
      .eq('id', product_id)
      .single<{
        id: string
        name: string
        description: string | null
        project_id: string | null
        global_style_settings: GlobalStyleSettings | null
        prodai_projects: { global_style_settings: GlobalStyleSettings | null } | null
      }>()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const projectStyles = product.prodai_projects?.global_style_settings ?? {}
    const settings = mergeStyles(projectStyles, product.global_style_settings ?? undefined)

    const userMessage = buildRefinedPromptUserMessage(product.name, product.description, settings, user_prompt)

    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 4096,
      system:
        'You are a product photography director. Refine the user\'s prompt idea into a detailed, specific image generation prompt. Incorporate the product\'s style settings naturally. Output ONLY the refined prompt text, no explanation.',
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = safeTextFromContent(response.content)

    return NextResponse.json({ refined_prompt: text.trim() })
  } catch (err) {
    // Log the full error internally but never echo raw error messages back to
    // the client — they can contain API keys or internal query details.
    logger.error('[BuildPrompt] Error:', err instanceof Error ? err.message : String(err))
    await logError({
      productId: product_id,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/ai/build-prompt',
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
