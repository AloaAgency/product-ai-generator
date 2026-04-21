import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { buildRefinedPromptUserMessage } from '@/lib/prompt-builder'
import type { GlobalStyleSettings } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'

export async function POST(request: NextRequest) {
  let product_id: string | undefined

  let body: { product_id?: string; user_prompt?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
  }

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

    const anthropic = new Anthropic()
    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 4096,
      system:
        'You are a product photography director. Refine the user\'s prompt idea into a detailed, specific image generation prompt. Incorporate the product\'s style settings naturally. Output ONLY the refined prompt text, no explanation.',
      messages: [{ role: 'user', content: userMessage }],
    })

    const text =
      response.content[0].type === 'text' ? response.content[0].text : ''

    return NextResponse.json({ refined_prompt: text.trim() })
  } catch (err) {
    // Log the full error internally but never echo raw error messages back to
    // the client — they can contain API keys or internal query details.
    console.error('[BuildPrompt] Error:', err)
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
