/**
 * Product image prompt builder
 * Uses Claude to refine user prompts with global product style settings
 */

import type { GlobalStyleSettings } from './types'

/**
 * Shared system prompt for generating short scene titles from a prompt text.
 * Used by both the dedicated /api/ai/scene-title route and inline title generation
 * in /api/products/[id]/prompts — kept here so both callers stay in sync.
 */
export const SCENE_TITLE_SYSTEM_PROMPT =
  'Generate a short (3-6 word) descriptive title for this product photography scene. Output ONLY the title.'

/** Maximum character lengths for AI-interpolated fields — guards against injection and oversized API payloads */
export const MAX_PRODUCT_NAME_LEN = 200
export const MAX_PRODUCT_DESC_LEN = 500
export const MAX_USER_PROMPT_LEN = 2000
export const MAX_STYLE_VALUE_LEN = 500
export const MAX_SUGGESTION_COUNT = 20
/** Max length for a suggestion name returned by parsePromptSuggestions — matches the DB-layer validation in the prompts route */
export const MAX_SUGGESTION_NAME_LEN = 500

/**
 * Allowlist of GlobalStyleSettings keys that are safe and relevant to include in
 * AI prompts. Excludes API keys, internal IDs, and UI-only fields like counts
 * and fidelity that must never appear in Claude or Gemini requests.
 */
const STYLE_PROMPT_KEYS: ReadonlyArray<keyof GlobalStyleSettings> = [
  'subject_rule',
  'lens',
  'camera_height',
  'color_grading',
  'lighting',
  'style',
  'constraints',
  'reference_rule',
  'default_resolution',
  'default_aspect_ratio',
  'custom_suffix',
]

/**
 * Build a bullet-point style block from settings.
 * Only includes fields from the safe allowlist — API keys, internal IDs,
 * and non-visual fields are never interpolated into AI prompts.
 */
export function buildStyleBlock(settings: GlobalStyleSettings): string {
  return STYLE_PROMPT_KEYS
    .filter(k => {
      const v = settings[k]
      return typeof v === 'string' && (v as string).trim()
    })
    .map(k => `• ${k}: ${(settings[k] as string).slice(0, MAX_STYLE_VALUE_LEN)}`)
    .join('\n')
}

/**
 * Build the user message for Claude's prompt-refinement call.
 * Sanitizes all user-controlled and DB-sourced fields before AI interpolation.
 * Mirrors the truncation AND quote sanitization applied in buildPromptSuggestionSystemPrompt
 * so that both AI endpoints enforce identical injection / payload limits.
 * Double-quotes are replaced with a typographic alternative (″) to prevent an adversarial
 * product name or description from injecting instructions into the assembled message.
 */
export function buildRefinedPromptUserMessage(
  productName: string,
  productDescription: string | null,
  settings: GlobalStyleSettings,
  userPrompt: string
): string {
  const safeName = productName.slice(0, MAX_PRODUCT_NAME_LEN).replace(/"/g, '\u2033').replace(/[\r\n]/g, ' ')
  const safeDesc = productDescription
    ? productDescription.slice(0, MAX_PRODUCT_DESC_LEN).replace(/"/g, '\u2033').replace(/[\r\n]/g, ' ')
    : null
  const safePrompt = userPrompt.slice(0, MAX_USER_PROMPT_LEN)
  const styleBlock = buildStyleBlock(settings)
  return (
    `Product: ${safeName}` +
    (safeDesc ? `\nDescription: ${safeDesc}` : '') +
    (styleBlock ? `\n\nStyle settings:\n${styleBlock}` : '') +
    `\n\nUser's prompt idea:\n${safePrompt}`
  )
}

/**
 * Assemble a full generation prompt from user prompt + global settings + reference count
 */
export function buildFullPrompt(
  userPrompt: string,
  settings: GlobalStyleSettings,
  referenceImageCount: number,
  textureImageCount: number = 0
): string {
  const parts: string[] = []

  // Mandatory style requirements block — truncate each value to match the allowlist guard
  // in buildStyleBlock so both prompt-assembly paths enforce identical payload limits.
  const cap = (v: string | undefined) => v?.slice(0, MAX_STYLE_VALUE_LEN) ?? ''
  const styleLines: string[] = []
  if (settings.subject_rule) styleLines.push(`Subject: ${cap(settings.subject_rule)}`)
  if (settings.lens) styleLines.push(`Lens: ${cap(settings.lens)}`)
  if (settings.camera_height) styleLines.push(`Camera height: ${cap(settings.camera_height)}`)
  if (settings.color_grading) styleLines.push(`Color grading: ${cap(settings.color_grading)}`)
  if (settings.lighting) styleLines.push(`Lighting: ${cap(settings.lighting)}`)
  if (settings.style) styleLines.push(`Style: ${cap(settings.style)}`)
  if (settings.constraints) styleLines.push(`Constraints: ${cap(settings.constraints)}`)

  if (styleLines.length > 0) {
    parts.push(`MANDATORY STYLE REQUIREMENTS (you must follow these):\n${styleLines.map(l => `• ${l}`).join('\n')}`)
  }

  // Reference rule - handle both product and texture images
  let refRule: string
  if (settings.reference_rule) {
    refRule = settings.reference_rule.slice(0, MAX_STYLE_VALUE_LEN)
  } else if (textureImageCount > 0) {
    refRule = `The attached images include ${referenceImageCount} product reference images followed by ${textureImageCount} texture reference images. The product images define the product appearance and must be matched exactly. The texture images show material/finish samples to use for realistic surface rendering.`
  } else {
    refRule = `The attached ${referenceImageCount} images define the product. The image generator must match them exactly.`
  }
  parts.push(`REFERENCE RULE: ${refRule}`)

  // User prompt — truncated to prevent oversized API payloads
  parts.push(`IMAGE TO GENERATE:\n${userPrompt.trim().slice(0, MAX_USER_PROMPT_LEN)}`)

  // Resolution/aspect suffix — cap to match MAX_STYLE_VALUE_LEN guard applied to all other style fields
  const resolution = cap(settings.default_resolution) || '4K'
  const aspect = cap(settings.default_aspect_ratio) || '16:9'
  parts.push(`${aspect} aspect ratio, ${resolution} resolution, professional quality`)

  if (settings.custom_suffix?.trim()) {
    parts.push(settings.custom_suffix.trim().slice(0, MAX_STYLE_VALUE_LEN))
  }

  return parts.join('\n\n')
}

/**
 * Build system prompt for Claude to suggest product image prompts
 */
export function buildPromptSuggestionSystemPrompt(
  productName: string,
  productDescription: string | null,
  settings: GlobalStyleSettings,
  count: number
): string {
  // Sanitize interpolated fields to prevent prompt injection and oversized API payloads.
  // Double-quotes are replaced with a typographic alternative so they cannot break out of
  // the inline "product name" context in the assembled system prompt.
  const safeName = productName.slice(0, MAX_PRODUCT_NAME_LEN).replace(/"/g, '\u2033').replace(/[\r\n]/g, ' ')
  const safeDesc = productDescription
    ? productDescription.slice(0, MAX_PRODUCT_DESC_LEN).replace(/"/g, '\u2033').replace(/[\r\n]/g, ' ')
    : null
  const safeCount = Math.max(1, Math.min(Math.floor(count), MAX_SUGGESTION_COUNT))

  const styleBlock = buildStyleBlock(settings)

  return `You are a product photography director. Generate exactly ${safeCount} unique image prompt ideas for the product "${safeName}"${safeDesc ? ` (${safeDesc})` : ''}.

${styleBlock ? `The product has these style requirements:\n${styleBlock}\n` : ''}

Each prompt should describe a specific scene, context, or composition where the product would look stunning. Be specific about:
- Setting/environment
- Composition and framing
- Mood and atmosphere
- Any props or complementary elements

Output ONLY valid JSON, no markdown fences:
{"prompts":[{"name":"Short title","prompt_text":"Detailed 50-150 word image generation prompt"}]}`
}

/** Pre-compiled regex for stripping markdown code fences — hoisted to avoid per-call recompilation */
const CODE_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i

/**
 * Parse Claude's prompt suggestion response
 */
export function parsePromptSuggestions(raw: string): { name: string; prompt_text: string }[] {
  if (!raw) return []

  // Extract JSON from possible code fences
  const match = raw.match(CODE_FENCE_RE)
  const jsonStr = match?.[1]?.trim() || raw.trim()

  try {
    const parsed = JSON.parse(jsonStr)
    const prompts = Array.isArray(parsed) ? parsed : parsed?.prompts
    if (!Array.isArray(prompts)) return []
    return prompts
      .map((p: any) => ({
        // Cap fields so an oversized or adversarial AI response cannot push unbounded
        // strings into DB inserts or API responses downstream.
        // String() coercion prevents a TypeError when the AI returns a non-string value
        // (e.g. a number) for these fields — without it, .trim() would throw and the
        // entire response would be silently discarded by the outer catch.
        name: String(p.name || p.title || '').trim().slice(0, MAX_SUGGESTION_NAME_LEN),
        prompt_text: String(p.prompt_text || p.promptText || p.prompt || '').trim().slice(0, MAX_USER_PROMPT_LEN),
      }))
      .filter((p: { name: string; prompt_text: string }) => p.prompt_text.length > 0)
  } catch (err) {
    console.warn(
      '[parsePromptSuggestions] Failed to parse JSON response:',
      err instanceof Error ? err.message : String(err),
      '— raw snippet:',
      jsonStr.slice(0, 200)
    )
    return []
  }
}
