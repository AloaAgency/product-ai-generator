/**
 * Pure, side-effect-free helpers extracted from the image-generation route
 * (`src/app/api/products/[id]/generate/route.ts`).
 *
 * Keeping the validation / clamping logic here lets it be unit-tested directly
 * without standing up Supabase or the Next.js request pipeline. The route is a
 * thin wrapper that calls these and translates their results into HTTP
 * responses — behaviour must stay identical between the two.
 */
import { MAX_SUBJECT_LABEL_LEN, MAX_STYLE_VALUE_LEN } from '@/lib/prompt-builder'

export const MAX_PROMPT_LENGTH = 10000
export const DEFAULT_JOBS_LIMIT = 50
export const MAX_JOBS_LIMIT = 200
export const MAX_TOTAL_REFERENCE_IMAGES = 14
export const MAX_VARIATION_COUNT = 100
export const VALID_DELETE_SCOPES = ['active', 'failed', 'all', 'log'] as const

export type DeleteScope = (typeof VALID_DELETE_SCOPES)[number]

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReferenceSetSelection = {
  reference_set_id: string
  role: 'subject' | 'texture'
  image_count: number | null
  image_ids: string[] | null
  subject_label: string | null
}

/**
 * Validate and normalise the client-supplied `reference_sets` array.
 * Returns the parsed selections or a single human-readable error string
 * describing the first problem encountered.
 */
export function parseReferenceSetsInput(
  input: unknown
): { sets: ReferenceSetSelection[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'reference_sets must be a non-empty array' }
  }
  const sets: ReferenceSetSelection[] = []
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i]
    if (!item || typeof item !== 'object') {
      return { error: `reference_sets[${i}] must be an object` }
    }
    const r = item as Record<string, unknown>
    const refId = typeof r.reference_set_id === 'string' && r.reference_set_id.trim()
      ? r.reference_set_id
      : null
    if (!refId) return { error: `reference_sets[${i}].reference_set_id is required` }
    if (r.role !== 'subject' && r.role !== 'texture') {
      return { error: `reference_sets[${i}].role must be "subject" or "texture"` }
    }
    let imageIds: string[] | null = null
    if (r.image_ids != null) {
      if (!Array.isArray(r.image_ids)) {
        return { error: `reference_sets[${i}].image_ids must be an array of UUIDs` }
      }
      const ids: string[] = []
      const seen = new Set<string>()
      for (const v of r.image_ids) {
        if (typeof v !== 'string' || !UUID_RE.test(v)) {
          return { error: `reference_sets[${i}].image_ids must contain UUID strings` }
        }
        if (seen.has(v)) {
          return { error: `reference_sets[${i}].image_ids must not contain duplicates` }
        }
        seen.add(v)
        ids.push(v)
      }
      if (ids.length > 0) imageIds = ids
    }
    let imageCount: number | null = null
    if (r.image_count != null) {
      const n = Number(r.image_count)
      if (!Number.isInteger(n) || n < 0) {
        return { error: `reference_sets[${i}].image_count must be a non-negative integer` }
      }
      imageCount = n
    }
    let subjectLabel: string | null = null
    if (r.subject_label != null) {
      if (typeof r.subject_label !== 'string') {
        return { error: `reference_sets[${i}].subject_label must be a string` }
      }
      const trimmed = r.subject_label.trim().slice(0, MAX_SUBJECT_LABEL_LEN)
      if (trimmed) subjectLabel = trimmed
    }
    if (r.role === 'texture' && subjectLabel) {
      return { error: `reference_sets[${i}].subject_label only applies to subject sets` }
    }
    sets.push({
      reference_set_id: refId,
      role: r.role,
      image_count: imageCount,
      image_ids: imageIds,
      subject_label: subjectLabel,
    })
  }
  if (!sets.some(s => s.role === 'subject')) {
    return { error: 'reference_sets must include at least one subject set' }
  }
  return { sets }
}

export type ReferenceImageSelection = {
  finalCounts: number[]
  finalSelectedIds: (string[] | null)[]
  totalImages: number
}

/**
 * Resolve how many (and which) images each reference set contributes, given the
 * images that actually exist for each set. Explicit `image_ids` are validated
 * against the set's real images; otherwise the requested count is clamped to
 * what's available. Enforces the per-job total cap.
 */
export function resolveReferenceImageSelection<T extends { id: string }>(
  parsedSets: ReferenceSetSelection[],
  imagesBySetId: Map<string, T[]>,
  maxTotal: number = MAX_TOTAL_REFERENCE_IMAGES
): ReferenceImageSelection | { error: string } {
  const finalCounts: number[] = []
  const finalSelectedIds: (string[] | null)[] = []
  let totalImages = 0
  for (let i = 0; i < parsedSets.length; i += 1) {
    const ps = parsedSets[i]
    const setImages = imagesBySetId.get(ps.reference_set_id) ?? []
    const available = setImages.length
    if (ps.image_ids && ps.image_ids.length > 0) {
      const validIds = new Set(setImages.map(img => img.id))
      for (const imgId of ps.image_ids) {
        if (!validIds.has(imgId)) {
          return { error: `reference_sets[${i}].image_ids contains "${imgId}" which is not in the set` }
        }
      }
      finalSelectedIds.push([...ps.image_ids])
      finalCounts.push(ps.image_ids.length)
      totalImages += ps.image_ids.length
    } else {
      const requested = ps.image_count ?? available
      const final = Math.max(0, Math.min(requested, available))
      if (final === 0) {
        return { error: `reference_sets[${i}] has no available images` }
      }
      finalSelectedIds.push(null)
      finalCounts.push(final)
      totalImages += final
    }
  }
  if (totalImages > maxTotal) {
    return { error: `Total image count (${totalImages}) exceeds maximum of ${maxTotal}` }
  }
  return { finalCounts, finalSelectedIds, totalImages }
}

/**
 * Parse the `limit`/`offset` query params for the jobs listing, clamping limit
 * to [1, MAX_JOBS_LIMIT] (falling back to the default for non-numeric/zero
 * input) and offset to a non-negative integer.
 */
export function clampJobsPagination(
  limitParam: string | null,
  offsetParam: string | null
): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(limitParam) || DEFAULT_JOBS_LIMIT, 1), MAX_JOBS_LIMIT)
  const offset = Math.max(Number(offsetParam) || 0, 0)
  return { limit, offset }
}

/**
 * Validate a requested variation count. Returns the integer when it is a whole
 * number in [1, MAX_VARIATION_COUNT], otherwise null (the route turns null into
 * a 400). Non-numeric, fractional, zero, negative and out-of-range values are
 * all rejected.
 */
export function validateVariationCount(raw: unknown): number | null {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VARIATION_COUNT) {
    return null
  }
  return parsed
}

/**
 * Cap a per-generation style override: only non-blank strings pass through, and
 * they are truncated to MAX_STYLE_VALUE_LEN to keep oversized or injected
 * values out of the AI prompt. Anything else yields undefined (no override).
 */
export function capStyleValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.slice(0, MAX_STYLE_VALUE_LEN) : undefined
}

/** Whether a DELETE `scope` query param is one of the accepted values. */
export function isValidDeleteScope(scope: string): scope is DeleteScope {
  return (VALID_DELETE_SCOPES as readonly string[]).includes(scope)
}
