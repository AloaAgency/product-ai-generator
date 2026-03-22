import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import {
  buildPromptSuggestionSystemPrompt,
  parsePromptSuggestions,
} from '@/lib/prompt-builder'
import type { Product, Project } from '@/lib/types'
import { T } from '@/lib/db-tables'
import { mergeStyles } from '@/lib/style-merge'
import { logError } from '@/lib/error-logger'

export async function POST(request: NextRequest) {
  let product_id: string | undefined
  try {
    const body = await request.json()
    product_id = body.product_id
    const count = body.count ?? 5

    if (!product_id) {
      return NextResponse.json(
        { error: 'product_id is required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select('id,name,description,project_id,global_style_settings')
      .eq('id', product_id)
      .single()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const typedProduct = product as Product

    // Fetch parent project and merge styles
    let projectStyles = {}
    if (typedProduct.project_id) {
      const { data: project } = await supabase
        .from(T.projects)
        .select('global_style_settings')
        .eq('id', typedProduct.project_id)
        .single()
      if (project) {
        projectStyles = (project as Project).global_style_settings ?? {}
      }
    }
    const mergedSettings = mergeStyles(projectStyles, typedProduct.global_style_settings)

    const systemPrompt = buildPromptSuggestionSystemPrompt(
      typedProduct.name,
      typedProduct.description,
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
