/**
 * Product image prompt builder
 * Uses Claude to refine user prompts with global product style settings
 */

/** Maximum character lengths for AI-interpolated fields — guards against injection and oversized API payloads */
export const MAX_PRODUCT_NAME_LEN = 200
export const MAX_PRODUCT_DESC_LEN = 500
export const MAX_USER_PROMPT_LEN = 2000
export const MAX_STYLE_VALUE_LEN = 500
export const MAX_SUGGESTION_COUNT = 20

export interface GlobalStyleSettings {
  subject_rule?: string
  lens?: string
  camera_height?: string
  color_grading?: string
  lighting?: string
  style?: string
  constraints?: string
  reference_rule?: string
  default_resolution?: '2K' | '4K'
  default_aspect_ratio?: '16:9' | '1:1' | '9:16'
  custom_suffix?: string
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

  // Mandatory style requirements block
  const styleLines: string[] = []
  if (settings.subject_rule) styleLines.push(`Subject: ${settings.subject_rule}`)
  if (settings.lens) styleLines.push(`Lens: ${settings.lens}`)
  if (settings.camera_height) styleLines.push(`Camera height: ${settings.camera_height}`)
  if (settings.color_grading) styleLines.push(`Color grading: ${settings.color_grading}`)
  if (settings.lighting) styleLines.push(`Lighting: ${settings.lighting}`)
  if (settings.style) styleLines.push(`Style: ${settings.style}`)
  if (settings.constraints) styleLines.push(`Constraints: ${settings.constraints}`)

  if (styleLines.length > 0) {
    parts.push(`MANDATORY STYLE REQUIREMENTS (you must follow these):\n${styleLines.map(l => `• ${l}`).join('\n')}`)
  }

  // Reference rule - handle both product and texture images
  let refRule: string
  if (settings.reference_rule) {
    refRule = settings.reference_rule
  } else if (textureImageCount > 0) {
    refRule = `The attached images include ${referenceImageCount} product reference images followed by ${textureImageCount} texture reference images. The product images define the product appearance and must be matched exactly. The texture images show material/finish samples to use for realistic surface rendering.`
  } else {
    refRule = `The attached ${referenceImageCount} images define the product. The image generator must match them exactly.`
  }
  parts.push(`REFERENCE RULE: ${refRule}`)

  // User prompt — truncated to prevent oversized API payloads
  parts.push(`IMAGE TO GENERATE:\n${userPrompt.trim().slice(0, MAX_USER_PROMPT_LEN)}`)

  // Resolution/aspect suffix
  const resolution = settings.default_resolution || '4K'
  const aspect = settings.default_aspect_ratio || '16:9'
  parts.push(`${aspect} aspect ratio, ${resolution} resolution, professional quality`)

  if (settings.custom_suffix?.trim()) {
    parts.push(settings.custom_suffix.trim())
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
  // Sanitize interpolated fields to prevent prompt injection and oversized API payloads
  const safeName = productName.slice(0, MAX_PRODUCT_NAME_LEN)
  const safeDesc = productDescription ? productDescription.slice(0, MAX_PRODUCT_DESC_LEN) : null
  const safeCount = Math.max(1, Math.min(Math.floor(count), MAX_SUGGESTION_COUNT))

  const styleBlock = Object.entries(settings)
    .filter(([, v]) => typeof v === 'string' && (v as string).trim())
    .map(([k, v]) => `• ${k}: ${(v as string).slice(0, MAX_STYLE_VALUE_LEN)}`)
    .join('\n')

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

/**
 * Parse Claude's prompt suggestion response
 */
export function parsePromptSuggestions(raw: string): { name: string; prompt_text: string }[] {
  if (!raw) return []

  // Extract JSON from possible code fences
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonStr = match?.[1]?.trim() || raw.trim()

  try {
    const parsed = JSON.parse(jsonStr)
    const prompts = Array.isArray(parsed) ? parsed : parsed?.prompts
    if (!Array.isArray(prompts)) return []
    return prompts
      .map((p: any) => ({
        name: (p.name || p.title || '').trim(),
        prompt_text: (p.prompt_text || p.promptText || p.prompt || '').trim(),
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
