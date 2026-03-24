import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { MAX_PRODUCT_NAME_LEN, MAX_PRODUCT_DESC_LEN, MAX_USER_PROMPT_LEN, MAX_STYLE_VALUE_LEN } from '@/lib/prompt-builder'
import type { Product, Project } from '@/lib/types'
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

    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select('id,name,description,project_id,global_style_settings')
      .eq('id', product_id)
      .single()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const typedProduct = product as Product

    // Fetch parent project in parallel if project_id is known
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
    const settings = mergeStyles(projectStyles, typedProduct.global_style_settings)

    // Truncate user-controlled and DB-sourced fields before AI interpolation to
    // prevent oversized payloads and limit prompt injection surface area
    const safeName = typedProduct.name.slice(0, MAX_PRODUCT_NAME_LEN)
    const safeDesc = typedProduct.description ? typedProduct.description.slice(0, MAX_PRODUCT_DESC_LEN) : null
    const safePrompt = user_prompt.slice(0, MAX_USER_PROMPT_LEN)

    const styleBlock = Object.entries(settings)
      .filter(([, v]) => typeof v === 'string' && (v as string).trim())
      .map(([k, v]) => `- ${k}: ${(v as string).slice(0, MAX_STYLE_VALUE_LEN)}`)
      .join('\n')

    const userMessage = `Product: ${safeName}${safeDesc ? `\nDescription: ${safeDesc}` : ''}${styleBlock ? `\n\nStyle settings:\n${styleBlock}` : ''}\n\nUser's prompt idea:\n${safePrompt}`

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
    console.error('[BuildPrompt] Error:', err)
    await logError({
      productId: product_id,
      errorMessage: err instanceof Error ? err.message : 'Internal server error',
      errorSource: 'api/ai/build-prompt',
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
