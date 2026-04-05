import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import {
  buildPromptSuggestionSystemPrompt,
  parsePromptSuggestions,
} from '@/lib/prompt-builder'
import type { GlobalStyleSettings } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'

export async function POST(request: NextRequest) {
  let product_id: string | undefined

  let body: { product_id?: string; count?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
  }

  try {
    product_id = body.product_id
    const count = body.count ?? 5

    if (!product_id) {
      return NextResponse.json(
        { error: 'product_id is required' },
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
    const mergedSettings = mergeStyles(projectStyles, product.global_style_settings ?? undefined)

    const systemPrompt = buildPromptSuggestionSystemPrompt(
      product.name,
      product.description,
      mergedSettings,
      count
    )

    const anthropic = new Anthropic()
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

    const text =
      response.content[0].type === 'text' ? response.content[0].text : ''

    const prompts = parsePromptSuggestions(text)

    return NextResponse.json({ prompts })
  } catch (err) {
    console.error('[SuggestPrompts] Error:', err)
    await logError({
      productId: product_id,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/ai/suggest-prompts',
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
