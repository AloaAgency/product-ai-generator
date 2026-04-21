import { describe, it, expect } from 'vitest'

import {
  buildFullPrompt,
  buildPromptSuggestionSystemPrompt,
  buildRefinedPromptUserMessage,
  MAX_PRODUCT_DESC_LEN,
  MAX_PRODUCT_NAME_LEN,
  MAX_STYLE_VALUE_LEN,
  MAX_SUGGESTION_COUNT,
  MAX_USER_PROMPT_LEN,
  parsePromptSuggestions,
  SCENE_TITLE_SYSTEM_PROMPT,
} from '../prompt-builder'

// ---------------------------------------------------------------------------
// SCENE_TITLE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('SCENE_TITLE_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof SCENE_TITLE_SYSTEM_PROMPT).toBe('string')
    expect(SCENE_TITLE_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it('instructs Claude to produce only the title with no extra output', () => {
    expect(SCENE_TITLE_SYSTEM_PROMPT).toContain('Output ONLY the title')
  })
})

// ---------------------------------------------------------------------------
// buildRefinedPromptUserMessage
// ---------------------------------------------------------------------------

describe('buildRefinedPromptUserMessage', () => {
  it('includes the product name', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', null, {}, 'Dark background')
    expect(msg).toContain('Product: Shampoo')
  })

  it('includes the description when provided', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', 'A premium shampoo', {}, 'Dark background')
    expect(msg).toContain('Description: A premium shampoo')
  })

  it('omits the description line when null', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', null, {}, 'Dark background')
    expect(msg).not.toContain('Description:')
    expect(msg).not.toContain('null')
  })

  it('includes the user prompt', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', null, {}, 'Moody forest scene')
    expect(msg).toContain("User's prompt idea:\nMoody forest scene")
  })

  it('includes style settings when present', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', null, { lens: '50mm', lighting: 'ring' }, 'Hero shot')
    expect(msg).toContain('Style settings:')
    expect(msg).toContain('• lens: 50mm')
  })

  it('omits the style settings block when settings are empty', () => {
    const msg = buildRefinedPromptUserMessage('Shampoo', null, {}, 'Hero shot')
    expect(msg).not.toContain('Style settings:')
  })

  it('truncates product name at MAX_PRODUCT_NAME_LEN', () => {
    const longName = 'N'.repeat(MAX_PRODUCT_NAME_LEN + 50)
    const msg = buildRefinedPromptUserMessage(longName, null, {}, 'Shot')
    const nameInMsg = msg.split('\n')[0].replace('Product: ', '')
    expect(nameInMsg.length).toBe(MAX_PRODUCT_NAME_LEN)
  })

  it('truncates description at MAX_PRODUCT_DESC_LEN', () => {
    const longDesc = 'D'.repeat(MAX_PRODUCT_DESC_LEN + 50)
    const msg = buildRefinedPromptUserMessage('Bottle', longDesc, {}, 'Shot')
    expect(msg.includes(longDesc)).toBe(false)
    expect(msg.includes('D'.repeat(MAX_PRODUCT_DESC_LEN))).toBe(true)
  })

  it('truncates user prompt at MAX_USER_PROMPT_LEN', () => {
    const longPrompt = 'P'.repeat(MAX_USER_PROMPT_LEN + 100)
    const msg = buildRefinedPromptUserMessage('Bottle', null, {}, longPrompt)
    const promptSection = msg.split("User's prompt idea:\n")[1] ?? ''
    expect(promptSection.length).toBe(MAX_USER_PROMPT_LEN)
  })

  it('replaces double-quotes in product name to prevent prompt injection', () => {
    const msg = buildRefinedPromptUserMessage('Brand "Premium" Bottle', null, {}, 'Hero shot')
    // ASCII double-quotes must not appear in the sanitized name
    expect(msg).not.toContain('"Premium"')
    // Typographic double-prime ″ (U+2033) replaces them
    expect(msg).toContain('\u2033Premium\u2033')
  })

  it('replaces double-quotes in product description to prevent prompt injection', () => {
    const msg = buildRefinedPromptUserMessage('Bottle', 'A "premium" glass bottle', {}, 'Hero shot')
    expect(msg).not.toContain('"premium"')
    expect(msg).toContain('\u2033premium\u2033')
  })
})

// ---------------------------------------------------------------------------
// buildFullPrompt
// ---------------------------------------------------------------------------

describe('buildFullPrompt', () => {
  it('includes the MANDATORY STYLE REQUIREMENTS block when settings have values', () => {
    const prompt = buildFullPrompt(
      'A bottle on a white table',
      { lens: '85mm', lighting: 'softbox', style: 'editorial' },
      3
    )

    expect(prompt).toContain('MANDATORY STYLE REQUIREMENTS')
    expect(prompt).toContain('• Lens: 85mm')
    expect(prompt).toContain('• Lighting: softbox')
    expect(prompt).toContain('• Style: editorial')
  })

  it('omits the MANDATORY STYLE REQUIREMENTS block when settings are empty', () => {
    const prompt = buildFullPrompt('A bottle on a white table', {}, 3)

    expect(prompt).not.toContain('MANDATORY STYLE REQUIREMENTS')
  })

  it('includes the IMAGE TO GENERATE section with the user prompt', () => {
    const prompt = buildFullPrompt('A dark background shot', {}, 2)

    expect(prompt).toContain('IMAGE TO GENERATE:')
    expect(prompt).toContain('A dark background shot')
  })

  it('truncates user prompts longer than MAX_USER_PROMPT_LEN characters', () => {
    const longPrompt = 'x'.repeat(MAX_USER_PROMPT_LEN + 500)
    const result = buildFullPrompt(longPrompt, {}, 1)

    // The truncated prompt appears inside the IMAGE TO GENERATE section
    const section = result.split('IMAGE TO GENERATE:\n')[1]?.split('\n\n')[0] ?? ''
    expect(section.length).toBe(MAX_USER_PROMPT_LEN)
  })

  it('uses a custom reference_rule when provided', () => {
    const customRule = 'Use only the first image as the product reference.'
    const prompt = buildFullPrompt('Hero shot', { reference_rule: customRule }, 5)

    expect(prompt).toContain(`REFERENCE RULE: ${customRule}`)
    expect(prompt).not.toContain('define the product')
  })

  it('generates the correct reference rule for product-only images', () => {
    const prompt = buildFullPrompt('Hero shot', {}, 4)

    expect(prompt).toContain('REFERENCE RULE:')
    expect(prompt).toContain('4 images define the product')
    expect(prompt).toContain('match them exactly')
  })

  it('generates a combined reference rule when texture images are provided', () => {
    const prompt = buildFullPrompt('Hero shot', {}, 3, 2)

    expect(prompt).toContain('3 product reference images')
    expect(prompt).toContain('2 texture reference images')
    expect(prompt).toContain('material/finish samples')
  })

  it('includes the resolution and aspect ratio suffix', () => {
    const prompt = buildFullPrompt('Product shot', { default_resolution: '2K', default_aspect_ratio: '1:1' }, 1)

    expect(prompt).toContain('1:1 aspect ratio, 2K resolution')
  })

  it('defaults to 4K resolution and 16:9 aspect ratio when not specified', () => {
    const prompt = buildFullPrompt('Product shot', {}, 1)

    expect(prompt).toContain('16:9 aspect ratio, 4K resolution')
  })

  it('appends custom_suffix when provided and non-empty', () => {
    const prompt = buildFullPrompt('Product shot', { custom_suffix: 'No watermarks.' }, 1)

    expect(prompt).toContain('No watermarks.')
  })

  it('does not append custom_suffix when it is whitespace-only', () => {
    const prompt = buildFullPrompt('Product shot', { custom_suffix: '   ' }, 1)
    const lines = prompt.split('\n\n')
    // The last section should be the resolution line, not a whitespace-only block
    expect(lines.at(-1)).toMatch(/aspect ratio/)
  })

  it('trims leading and trailing whitespace from the user prompt', () => {
    const prompt = buildFullPrompt('  trimmed prompt  ', {}, 1)
    expect(prompt).toContain('IMAGE TO GENERATE:\ntrimmed prompt')
  })

  it('parts are separated by double newlines', () => {
    const prompt = buildFullPrompt('shot', { lens: '50mm' }, 1)
    // All section separators must be exactly \n\n (not \n or \n\n\n)
    const parts = prompt.split('\n\n')
    expect(parts.length).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// parsePromptSuggestions
// ---------------------------------------------------------------------------

describe('parsePromptSuggestions', () => {
  it('returns an empty array for empty input', () => {
    expect(parsePromptSuggestions('')).toStrictEqual([])
  })

  it('parses a raw JSON array', () => {
    const raw = JSON.stringify([
      { name: 'Forest shot', prompt_text: 'A bottle in a dense forest' },
    ])
    expect(parsePromptSuggestions(raw)).toStrictEqual([
      { name: 'Forest shot', prompt_text: 'A bottle in a dense forest' },
    ])
  })

  it('parses a JSON object with a prompts key', () => {
    const raw = JSON.stringify({
      prompts: [
        { name: 'Beach shot', prompt_text: 'A product on the beach at sunset' },
      ],
    })
    expect(parsePromptSuggestions(raw)).toStrictEqual([
      { name: 'Beach shot', prompt_text: 'A product on the beach at sunset' },
    ])
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n{"prompts":[{"name":"Fenced","prompt_text":"Fenced prompt"}]}\n```'
    expect(parsePromptSuggestions(raw)).toStrictEqual([
      { name: 'Fenced', prompt_text: 'Fenced prompt' },
    ])
  })

  it('returns an empty array for malformed JSON', () => {
    expect(parsePromptSuggestions('{ broken json')).toStrictEqual([])
  })

  it('filters out items with an empty prompt_text', () => {
    const raw = JSON.stringify({
      prompts: [
        { name: 'Valid', prompt_text: 'A real prompt' },
        { name: 'Empty', prompt_text: '' },
      ],
    })
    expect(parsePromptSuggestions(raw)).toHaveLength(1)
    expect(parsePromptSuggestions(raw)[0]?.name).toBe('Valid')
  })

  it('handles the alternative field name "promptText"', () => {
    const raw = JSON.stringify([{ name: 'Alt', promptText: 'Alt prompt text' }])
    expect(parsePromptSuggestions(raw)[0]?.prompt_text).toBe('Alt prompt text')
  })

  it('handles the alternative field name "prompt"', () => {
    const raw = JSON.stringify([{ name: 'AltPrompt', prompt: 'Prompt field value' }])
    expect(parsePromptSuggestions(raw)[0]?.prompt_text).toBe('Prompt field value')
  })

  it('falls back to "title" when "name" is missing', () => {
    const raw = JSON.stringify([{ title: 'Title as name', prompt_text: 'A prompt' }])
    expect(parsePromptSuggestions(raw)[0]?.name).toBe('Title as name')
  })

  it('returns an empty array when JSON is valid but does not contain a prompts array', () => {
    const raw = JSON.stringify({ something: 'else' })
    expect(parsePromptSuggestions(raw)).toStrictEqual([])
  })

  it('handles non-string name values from adversarial AI responses without throwing', () => {
    // A number as the name field must not cause .trim() to throw
    const raw = JSON.stringify([{ name: 42, prompt_text: 'Valid prompt text here' }])
    const result = parsePromptSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('42')
    expect(result[0]?.prompt_text).toBe('Valid prompt text here')
  })

  it('handles non-string prompt_text values from adversarial AI responses without throwing', () => {
    // A number as the prompt_text field must not cause .trim() to throw
    const raw = JSON.stringify([{ name: 'Shot title', prompt_text: 99 }])
    const result = parsePromptSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0]?.prompt_text).toBe('99')
  })
})

// ---------------------------------------------------------------------------
// buildPromptSuggestionSystemPrompt — injection prevention via field slicing
// ---------------------------------------------------------------------------

describe('buildPromptSuggestionSystemPrompt', () => {
  it('includes the product name and count in the output', () => {
    const result = buildPromptSuggestionSystemPrompt('Cool Bottle', null, {}, 5)
    expect(result).toContain('"Cool Bottle"')
    expect(result).toContain('exactly 5 unique')
  })

  it('includes the product description when provided', () => {
    const result = buildPromptSuggestionSystemPrompt('Bottle', 'A premium glass bottle', {}, 3)
    expect(result).toContain('A premium glass bottle')
  })

  it('omits the description placeholder when null', () => {
    const result = buildPromptSuggestionSystemPrompt('Bottle', null, {}, 3)
    expect(result).not.toContain('(null)')
    expect(result).not.toContain('undefined')
  })

  it('clamps count below 1 to exactly 1', () => {
    const result = buildPromptSuggestionSystemPrompt('Bottle', null, {}, 0)
    expect(result).toContain('exactly 1 unique')
  })

  it('clamps count above MAX_SUGGESTION_COUNT to MAX_SUGGESTION_COUNT', () => {
    const result = buildPromptSuggestionSystemPrompt('Bottle', null, {}, MAX_SUGGESTION_COUNT + 50)
    expect(result).toContain(`exactly ${MAX_SUGGESTION_COUNT} unique`)
    expect(result).not.toContain(`${MAX_SUGGESTION_COUNT + 50}`)
  })

  it('truncates product name at MAX_PRODUCT_NAME_LEN to prevent prompt injection via oversized input', () => {
    const longName = 'A'.repeat(MAX_PRODUCT_NAME_LEN + 100)
    const result = buildPromptSuggestionSystemPrompt(longName, null, {}, 3)
    // The name appears in quotes; it should be capped
    const nameInResult = result.match(/"([^"]+)"/)?.[1] ?? ''
    expect(nameInResult.length).toBeLessThanOrEqual(MAX_PRODUCT_NAME_LEN)
  })

  it('truncates product description at MAX_PRODUCT_DESC_LEN', () => {
    const longDesc = 'B'.repeat(MAX_PRODUCT_DESC_LEN + 200)
    const result = buildPromptSuggestionSystemPrompt('Bottle', longDesc, {}, 3)
    // The description appears inside parentheses in the prompt
    expect(result.includes(longDesc)).toBe(false)
    expect(result.includes('B'.repeat(MAX_PRODUCT_DESC_LEN))).toBe(true)
  })

  it('includes style settings as bullet points', () => {
    const result = buildPromptSuggestionSystemPrompt(
      'Bottle',
      null,
      { lens: '85mm', lighting: 'softbox' },
      3
    )
    expect(result).toContain('• lens: 85mm')
    expect(result).toContain('• lighting: softbox')
  })

  it('truncates style values at MAX_STYLE_VALUE_LEN', () => {
    const longStyle = 'C'.repeat(MAX_STYLE_VALUE_LEN + 100)
    const result = buildPromptSuggestionSystemPrompt('Bottle', null, { lens: longStyle }, 3)
    expect(result.includes(longStyle)).toBe(false)
    expect(result.includes('C'.repeat(MAX_STYLE_VALUE_LEN))).toBe(true)
  })
})
