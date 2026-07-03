/**
 * Product image prompt builder
 * Uses Claude to refine user prompts with global product style settings
 */

import Anthropic from '@anthropic-ai/sdk'
import type { GlobalStyleSettings } from '@/lib/types'
import { CLAUDE_FAST_MODEL } from '@/lib/claude-models'
import { logger } from '@/lib/logger'

const anthropic = new Anthropic()

/**
 * Shared system prompt for generating short scene titles from a prompt text.
 * Used by the dedicated /api/ai/scene-title route and inline title generation
 * in /api/products/[id]/prompts (via generateSceneTitle below).
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
 * Validate a requested suggestion count from the client. Returns the floored
 * integer when the value is a finite number in [1, MAX_SUGGESTION_COUNT],
 * otherwise null (the route turns null into a 400).
 *
 * Rejecting non-finite input here is important: a NaN slipping through would
 * reach the system prompt as "exactly NaN unique…", silently corrupting the
 * request instead of failing fast.
 */
export function validateSuggestionCount(raw: unknown): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_SUGGESTION_COUNT) {
    return null
  }
  return Math.floor(parsed)
}

/**
 * Generate a short scene title for a prompt using Claude.
 * Returns an empty string on AI failure so callers can save the prompt without a title.
 * Used by the /api/products/[id]/prompts routes for inline title generation.
 */
export async function generateSceneTitle(promptText: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_FAST_MODEL.name,
      max_tokens: 50,
      system: SCENE_TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: promptText.slice(0, MAX_USER_PROMPT_LEN) }],
    })
    return safeTextFromContent(response.content).trim()
  } catch (err) {
    logger.warn('[generateSceneTitle] AI call failed, title will be empty:', err instanceof Error ? err.message : String(err))
    return ''
  }
}

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
 * Truncate, sanitize double-quotes, and strip newlines from a field before AI interpolation.
 * Used by both prompt-building functions so they enforce identical injection / payload limits.
 */
function sanitizeField(value: string, maxLen: number): string {
  return value.slice(0, maxLen).replace(/"/g, '″').replace(/[\r\n]/g, ' ')
}

/**
 * Build a bullet-point style block from settings.
 * Only includes fields from the safe allowlist — API keys, internal IDs,
 * and non-visual fields are never interpolated into AI prompts.
 */
export function buildStyleBlock(settings: GlobalStyleSettings): string {
  // Single pass: trim each value once and skip empties, instead of trimming in a
  // filter and again in a map (which also allocated an intermediate filtered array).
  const lines: string[] = []
  for (const k of STYLE_PROMPT_KEYS) {
    const v = settings[k]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (!trimmed) continue
    lines.push(`• ${k}: ${trimmed.slice(0, MAX_STYLE_VALUE_LEN)}`)
  }
  return lines.join('\n')
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
  const safeName = sanitizeField(productName, MAX_PRODUCT_NAME_LEN)
  const safeDesc = productDescription ? sanitizeField(productDescription, MAX_PRODUCT_DESC_LEN) : null
  const safePrompt = userPrompt.slice(0, MAX_USER_PROMPT_LEN)
  const styleBlock = buildStyleBlock(settings)
  return (
    `Product: ${safeName}` +
    (safeDesc ? `\nDescription: ${safeDesc}` : '') +
    (styleBlock ? `\n\nStyle settings:\n${styleBlock}` : '') +
    `\n\nUser's prompt idea:\n${safePrompt}`
  )
}

/** Per-set descriptor passed to buildFullPrompt — one entry per reference set attached to the job. */
export type ReferenceGroup = {
  role: 'subject' | 'texture'
  count: number
  label?: string | null
}

/** Max subject_label length — kept short so an adversarial label can't blow the prompt budget. */
export const MAX_SUBJECT_LABEL_LEN = 80

function sanitizeLabel(label: string | null | undefined): string {
  if (!label) return ''
  return label.slice(0, MAX_SUBJECT_LABEL_LEN).replace(/"/g, '″').replace(/[\r\n]/g, ' ').trim()
}

function subjectName(label: string, subjectIndex: number, totalSubjects: number): string {
  if (label) return label
  if (totalSubjects <= 1) return 'the product'
  // A..Z then fall back to numeric — 14-image cap means we won't realistically hit 27 subjects.
  return subjectIndex <= 26
    ? `subject ${String.fromCharCode(64 + subjectIndex)}`
    : `subject ${subjectIndex}`
}

function buildReferenceRule(groups: ReferenceGroup[], customRule: string | undefined): string | null {
  if (customRule) return customRule.slice(0, MAX_STYLE_VALUE_LEN)

  const active = groups.filter(g => g.count > 0)
  if (active.length === 0) return null

  const totalSubjects = active.filter(g => g.role === 'subject').length
  const lines: string[] = []
  let cursor = 1
  let subjectIndex = 0
  for (const g of active) {
    const start = cursor
    const end = cursor + g.count - 1
    const range = start === end ? `Image ${start}` : `Images ${start}–${end}`
    if (g.role === 'texture') {
      lines.push(`${range} ${g.count === 1 ? 'is a' : 'are'} texture/material reference${g.count === 1 ? '' : 's'}; use them for realistic surface rendering.`)
    } else {
      subjectIndex += 1
      const name = subjectName(sanitizeLabel(g.label), subjectIndex, totalSubjects)
      lines.push(`${range} ${g.count === 1 ? 'is' : 'are'} ${name}; match this subject's appearance exactly.`)
    }
    cursor = end + 1
  }
  if (totalSubjects > 1) {
    lines.push('Compose all subjects together into a single coherent scene as described in the prompt.')
  }
  return lines.join(' ')
}

/**
 * Field → display label pairs for the MANDATORY STYLE REQUIREMENTS block in
 * buildFullPrompt. A subset of STYLE_PROMPT_KEYS with human-readable labels;
 * reference_rule, resolution/aspect, and custom_suffix are excluded because
 * buildFullPrompt renders them as their own prompt sections.
 */
const FULL_PROMPT_STYLE_FIELDS = [
  ['subject_rule', 'Subject'],
  ['lens', 'Lens'],
  ['camera_height', 'Camera height'],
  ['color_grading', 'Color grading'],
  ['lighting', 'Lighting'],
  ['style', 'Style'],
  ['constraints', 'Constraints'],
] as const satisfies ReadonlyArray<readonly [keyof GlobalStyleSettings, string]>

/**
 * Assemble a full generation prompt from user prompt + global settings + per-set reference groups.
 * Pass groups in the same order the worker concatenates images so the per-range descriptions
 * line up with the actual image payload.
 */
export function buildFullPrompt(
  userPrompt: string,
  settings: GlobalStyleSettings,
  groups: ReferenceGroup[]
): string {
  const parts: string[] = []

  // Mandatory style requirements block — truncate each value to match the allowlist guard
  // in buildStyleBlock so both prompt-assembly paths enforce identical payload limits.
  const cap = (v: string | undefined) => v?.slice(0, MAX_STYLE_VALUE_LEN) ?? ''
  const styleLines: string[] = []
  for (const [key, label] of FULL_PROMPT_STYLE_FIELDS) {
    const value = settings[key]
    if (value) styleLines.push(`• ${label}: ${cap(value)}`)
  }

  if (styleLines.length > 0) {
    parts.push(`MANDATORY STYLE REQUIREMENTS (you must follow these):\n${styleLines.join('\n')}`)
  }

  const refRule = buildReferenceRule(groups, settings.reference_rule)
  if (refRule) {
    parts.push(`REFERENCE RULE: ${refRule}`)
  }

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
  const safeName = sanitizeField(productName, MAX_PRODUCT_NAME_LEN)
  const safeDesc = productDescription ? sanitizeField(productDescription, MAX_PRODUCT_DESC_LEN) : null
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

/** Pre-compiled regex for extracting JSON from markdown code fences (global for matchAll) */
const CODE_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi

/**
 * Safely extract the text from an Anthropic API response.
 * Returns the first text block's content, scanning past any non-text blocks
 * (e.g. a `thinking` or `tool_use` block the API may emit before the text)
 * rather than only inspecting index 0 — otherwise a leading non-text block
 * would make this silently return '' even when text is present.
 * Guards against empty content arrays, which can occur when the API returns an
 * unexpected stop reason (e.g. max_tokens reached at zero output).
 */
export function safeTextFromContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  const textBlock = content.find((block) => block?.type === 'text')
  return textBlock?.text ?? ''
}

/** A single parsed prompt suggestion — the shape returned by parsePromptSuggestions. */
export type PromptSuggestion = {
  name: string
  prompt_text: string
}

/**
 * Collect JSON candidate strings from a raw AI response, in priority order:
 * 1. Code fence contents (Claude sometimes wraps JSON in ```json``` despite instructions).
 * 2. Outer-brace extract — handles "Here is the JSON: {...}" prose-wrapped responses
 *    that have no fences. Scanning from first '{' to last '}' avoids a JSON.parse miss
 *    on the full raw string, preventing a silent empty return that the caller would retry.
 * 3. Full raw text as final fallback.
 */
function collectJsonCandidates(raw: string): string[] {
  // matchAll internally clones the regex, so CODE_FENCE_RE.lastIndex is not mutated.
  const fencedCandidates = Array.from(raw.matchAll(CODE_FENCE_RE), m => m[1]?.trim() ?? '').filter(Boolean)
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  const bracketExtract =
    firstBrace !== -1 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : null
  const rawTrimmed = raw.trim()
  return [
    ...fencedCandidates,
    ...(bracketExtract && bracketExtract !== rawTrimmed ? [bracketExtract] : []),
    rawTrimmed,
  ]
}

/**
 * Normalize a parsed suggestions array into capped, string-typed PromptSuggestions.
 * Defensive on every axis because the input comes straight from AI output:
 * - Caps the item count — the AI may return more items than requested (e.g. when
 *   it misreads the count); without this the caller could propagate an unbounded
 *   number of DB inserts or response entries.
 * - Skips null/non-object items from a malformed response — a null element would
 *   otherwise throw inside .map() and discard every valid suggestion.
 * - String()-coerces fields so a non-string value (e.g. a number) can't make
 *   .trim() throw, and caps field lengths so oversized output cannot push
 *   unbounded strings into DB inserts or API responses downstream.
 */
function normalizeSuggestions(items: unknown[]): PromptSuggestion[] {
  return items
    .slice(0, MAX_SUGGESTION_COUNT)
    .filter((p: unknown): p is Record<string, unknown> => p !== null && typeof p === 'object')
    .map((p) => ({
      name: String(p.name || p.title || '').trim().slice(0, MAX_SUGGESTION_NAME_LEN),
      prompt_text: String(p.prompt_text || p.promptText || p.prompt || '').trim().slice(0, MAX_USER_PROMPT_LEN),
    }))
    .filter((p: PromptSuggestion) => p.prompt_text.length > 0)
}

/**
 * Parse Claude's prompt suggestion response.
 * Tries each code fence block before falling back to raw text, so a response that
 * includes explanatory text in one fence and the JSON in another is handled correctly.
 * The first candidate that parses to an array (bare or under a "prompts" key) wins.
 */
export function parsePromptSuggestions(raw: string): PromptSuggestion[] {
  if (!raw) return []

  const candidates = collectJsonCandidates(raw)
  for (const jsonStr of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      continue
    }

    const prompts = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.prompts
    if (!Array.isArray(prompts)) continue

    return normalizeSuggestions(prompts)
  }

  logger.warn(
    '[parsePromptSuggestions] No valid JSON found in response:',
    `${candidates.length} candidate(s) tried, raw length ${raw.length}`,
    '— raw snippet:',
    raw.slice(0, 200)
  )
  return []
}
