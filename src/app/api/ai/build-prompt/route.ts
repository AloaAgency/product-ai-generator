import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import type { Product } from '@/lib/types'
import { T } from '@/lib/db-tables'

export async function POST(request: NextRequest) {
  try {
    const { product_id, user_prompt } = await request.json()

    if (!product_id || !user_prompt) {
      return NextResponse.json(
        { error: 'product_id and user_prompt are required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: product, error: productError } = await supabase
      .from(T.products)
      .select('*')
      .eq('id', product_id)
      .single()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const typedProduct = product as Product
    const settings = typedProduct.global_style_settings

    const styleBlock = Object.entries(settings)
      .filter(([, v]) => typeof v === 'string' && (v as string).trim())
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n')

    const userMessage = `Product: ${typedProduct.name}${typedProduct.description ? `\nDescription: ${typedProduct.description}` : ''}${styleBlock ? `\n\nStyle settings:\n${styleBlock}` : ''}\n\nUser's prompt idea:\n${user_prompt}`

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
