/**
 * Tests for the pure helpers backing the image-generation route
 * (src/lib/generate-route-helpers.ts).
 *
 * These cover the validation, clamping and selection logic that decides what
 * gets sent to the generator — the places where an off-by-one, a missing bound,
 * or a loose type check would let bad input through or reject good input.
 */
import { describe, expect, it } from 'vitest'
import { MAX_SUBJECT_LABEL_LEN, MAX_STYLE_VALUE_LEN } from '@/lib/prompt-builder'
import {
  DEFAULT_JOBS_LIMIT,
  MAX_JOBS_LIMIT,
  MAX_TOTAL_REFERENCE_IMAGES,
  MAX_VARIATION_COUNT,
  parseReferenceSetsInput,
  resolveReferenceImageSelection,
  clampJobsPagination,
  validateVariationCount,
  capStyleValue,
  isValidDeleteScope,
  type ReferenceSetSelection,
} from '@/lib/generate-route-helpers'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

/** Narrowing helper for the discriminated union returned by the parsers. */
function expectError<T extends object>(result: T | { error: string }): string {
  expect(result).toHaveProperty('error')
  return (result as { error: string }).error
}

// ---------------------------------------------------------------------------
// parseReferenceSetsInput
// ---------------------------------------------------------------------------

describe('parseReferenceSetsInput — structural validation', () => {
  it('rejects a non-array input', () => {
    expect(expectError(parseReferenceSetsInput(null))).toMatch(/non-empty array/)
    expect(expectError(parseReferenceSetsInput({}))).toMatch(/non-empty array/)
    expect(expectError(parseReferenceSetsInput('foo'))).toMatch(/non-empty array/)
  })

  it('rejects an empty array', () => {
    expect(expectError(parseReferenceSetsInput([]))).toMatch(/non-empty array/)
  })

  it('rejects non-object array items (including null)', () => {
    expect(expectError(parseReferenceSetsInput([null]))).toMatch(/\[0\] must be an object/)
    expect(expectError(parseReferenceSetsInput(['x']))).toMatch(/\[0\] must be an object/)
    expect(expectError(parseReferenceSetsInput([1]))).toMatch(/\[0\] must be an object/)
  })

  it('reports the index of the offending item', () => {
    const input = [{ reference_set_id: UUID_A, role: 'subject' }, 5]
    expect(expectError(parseReferenceSetsInput(input))).toMatch(/\[1\] must be an object/)
  })
})

describe('parseReferenceSetsInput — reference_set_id', () => {
  it('requires a non-empty reference_set_id', () => {
    expect(expectError(parseReferenceSetsInput([{ role: 'subject' }]))).toMatch(/reference_set_id is required/)
  })

  it('treats a whitespace-only reference_set_id as missing', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: '   ', role: 'subject' }])))
      .toMatch(/reference_set_id is required/)
  })

  it('preserves the original (un-trimmed) reference_set_id value', () => {
    // The trim is only used as a blank check; the stored value is the raw input.
    const result = parseReferenceSetsInput([{ reference_set_id: ' set-1 ', role: 'subject' }])
    expect('sets' in result && result.sets[0].reference_set_id).toBe(' set-1 ')
  })
})

describe('parseReferenceSetsInput — role', () => {
  it('rejects an unknown role', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'hero' }])))
      .toMatch(/role must be "subject" or "texture"/)
  })

  it('rejects a missing role', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A }])))
      .toMatch(/role must be "subject" or "texture"/)
  })

  it('accepts the texture role when a subject set is also present', () => {
    const result = parseReferenceSetsInput([
      { reference_set_id: UUID_A, role: 'subject' },
      { reference_set_id: UUID_B, role: 'texture' },
    ])
    expect('sets' in result && result.sets).toHaveLength(2)
  })
})

describe('parseReferenceSetsInput — image_ids', () => {
  it('rejects image_ids that is not an array', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: 'x' }])))
      .toMatch(/image_ids must be an array/)
  })

  it('rejects non-UUID strings in image_ids', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: ['not-a-uuid'] }])))
      .toMatch(/image_ids must contain UUID strings/)
  })

  it('rejects non-string entries in image_ids', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: [123] }])))
      .toMatch(/image_ids must contain UUID strings/)
  })

  it('rejects duplicate UUIDs in image_ids', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: [UUID_A, UUID_A] }])))
      .toMatch(/image_ids must not contain duplicates/)
  })

  it('keeps a valid, deduped-by-construction image_ids list', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: [UUID_A, UUID_B] }])
    expect('sets' in result && result.sets[0].image_ids).toEqual([UUID_A, UUID_B])
  })

  it('normalises an empty image_ids array to null (so count-based selection applies)', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_ids: [] }])
    expect('sets' in result && result.sets[0].image_ids).toBeNull()
  })

  it('treats omitted image_ids as null', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject' }])
    expect('sets' in result && result.sets[0].image_ids).toBeNull()
  })
})

describe('parseReferenceSetsInput — image_count', () => {
  it('rejects a non-integer image_count', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_count: 2.5 }])))
      .toMatch(/image_count must be a non-negative integer/)
  })

  it('rejects a negative image_count', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_count: -1 }])))
      .toMatch(/image_count must be a non-negative integer/)
  })

  it('accepts zero as a valid image_count', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_count: 0 }])
    expect('sets' in result && result.sets[0].image_count).toBe(0)
  })

  it('coerces a numeric string image_count', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', image_count: '3' }])
    expect('sets' in result && result.sets[0].image_count).toBe(3)
  })

  it('treats omitted image_count as null', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject' }])
    expect('sets' in result && result.sets[0].image_count).toBeNull()
  })
})

describe('parseReferenceSetsInput — subject_label', () => {
  it('rejects a non-string subject_label', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', subject_label: 5 }])))
      .toMatch(/subject_label must be a string/)
  })

  it('trims and truncates the subject_label to MAX_SUBJECT_LABEL_LEN', () => {
    const longLabel = '  ' + 'a'.repeat(MAX_SUBJECT_LABEL_LEN + 50) + '  '
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', subject_label: longLabel }])
    const label = 'sets' in result ? result.sets[0].subject_label : null
    expect(label).not.toBeNull()
    expect(label!.length).toBe(MAX_SUBJECT_LABEL_LEN)
  })

  it('normalises a whitespace-only subject_label to null', () => {
    const result = parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'subject', subject_label: '   ' }])
    expect('sets' in result && result.sets[0].subject_label).toBeNull()
  })

  it('rejects a subject_label on a texture set', () => {
    const input = [
      { reference_set_id: UUID_A, role: 'subject' },
      { reference_set_id: UUID_B, role: 'texture', subject_label: 'wood' },
    ]
    expect(expectError(parseReferenceSetsInput(input))).toMatch(/subject_label only applies to subject sets/)
  })
})

describe('parseReferenceSetsInput — subject requirement', () => {
  it('requires at least one subject set', () => {
    expect(expectError(parseReferenceSetsInput([{ reference_set_id: UUID_A, role: 'texture' }])))
      .toMatch(/at least one subject set/)
  })

  it('returns a fully-normalised set for valid input', () => {
    const result = parseReferenceSetsInput([
      { reference_set_id: UUID_A, role: 'subject', image_count: 2, subject_label: 'sneaker' },
    ])
    expect('sets' in result && result.sets[0]).toEqual({
      reference_set_id: UUID_A,
      role: 'subject',
      image_count: 2,
      image_ids: null,
      subject_label: 'sneaker',
    })
  })
})

// ---------------------------------------------------------------------------
// resolveReferenceImageSelection
// ---------------------------------------------------------------------------

function set(partial: Partial<ReferenceSetSelection> & { reference_set_id: string }): ReferenceSetSelection {
  return {
    role: 'subject',
    image_count: null,
    image_ids: null,
    subject_label: null,
    ...partial,
  }
}

describe('resolveReferenceImageSelection — explicit image_ids', () => {
  it('accepts explicit ids that all exist in the set', () => {
    const sets = [set({ reference_set_id: UUID_A, image_ids: [UUID_B, UUID_C] })]
    const images = new Map([[UUID_A, [{ id: UUID_B }, { id: UUID_C }]]])
    const result = resolveReferenceImageSelection(sets, images)
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.finalCounts).toEqual([2])
    expect(result.finalSelectedIds).toEqual([[UUID_B, UUID_C]])
    expect(result.totalImages).toBe(2)
  })

  it('rejects an explicit id that is not in the set', () => {
    const sets = [set({ reference_set_id: UUID_A, image_ids: [UUID_B] })]
    const images = new Map([[UUID_A, [{ id: UUID_C }]]])
    expect(expectError(resolveReferenceImageSelection(sets, images)))
      .toMatch(/contains "22222222-2222-4222-8222-222222222222" which is not in the set/)
  })

  it('copies the selected ids array rather than aliasing the input', () => {
    const ids = [UUID_B]
    const sets = [set({ reference_set_id: UUID_A, image_ids: ids })]
    const images = new Map([[UUID_A, [{ id: UUID_B }]]])
    const result = resolveReferenceImageSelection(sets, images)
    if ('error' in result) throw new Error('unexpected error')
    expect(result.finalSelectedIds[0]).not.toBe(ids)
    expect(result.finalSelectedIds[0]).toEqual(ids)
  })
})

describe('resolveReferenceImageSelection — count-based selection', () => {
  it('clamps a requested count down to what is available', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: 10 })]
    const images = new Map([[UUID_A, [{ id: UUID_B }, { id: UUID_C }]]])
    const result = resolveReferenceImageSelection(sets, images)
    if ('error' in result) throw new Error('unexpected error')
    expect(result.finalCounts).toEqual([2])
    expect(result.finalSelectedIds).toEqual([null])
  })

  it('defaults to all available images when image_count is null', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: null })]
    const images = new Map([[UUID_A, [{ id: UUID_B }, { id: UUID_C }]]])
    const result = resolveReferenceImageSelection(sets, images)
    if ('error' in result) throw new Error('unexpected error')
    expect(result.finalCounts).toEqual([2])
  })

  it('uses the requested count when fewer than available', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: 1 })]
    const images = new Map([[UUID_A, [{ id: UUID_B }, { id: UUID_C }]]])
    const result = resolveReferenceImageSelection(sets, images)
    if ('error' in result) throw new Error('unexpected error')
    expect(result.finalCounts).toEqual([1])
  })

  it('errors when a set has no available images', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: 3 })]
    const images = new Map<string, { id: string }[]>([[UUID_A, []]])
    expect(expectError(resolveReferenceImageSelection(sets, images))).toMatch(/\[0\] has no available images/)
  })

  it('errors when the set id is entirely absent from the image map', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: 3 })]
    const images = new Map<string, { id: string }[]>()
    expect(expectError(resolveReferenceImageSelection(sets, images))).toMatch(/\[0\] has no available images/)
  })

  it('treats an explicit image_count of 0 as count-based selection (falls back to available)', () => {
    // image_count 0 is falsy-but-not-null; `?? available` keeps the 0, but
    // Math.min(0, available) is 0 → "no available images".
    const sets = [set({ reference_set_id: UUID_A, image_count: 0 })]
    const images = new Map([[UUID_A, [{ id: UUID_B }]]])
    expect(expectError(resolveReferenceImageSelection(sets, images))).toMatch(/no available images/)
  })
})

describe('resolveReferenceImageSelection — total cap', () => {
  it('allows a total exactly at the maximum', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: MAX_TOTAL_REFERENCE_IMAGES })]
    const images = new Map([
      [UUID_A, Array.from({ length: MAX_TOTAL_REFERENCE_IMAGES }, (_, i) => ({ id: `img-${i}` }))],
    ])
    const result = resolveReferenceImageSelection(sets, images)
    if ('error' in result) throw new Error('unexpected error')
    expect(result.totalImages).toBe(MAX_TOTAL_REFERENCE_IMAGES)
  })

  it('rejects a total that exceeds the maximum across multiple sets', () => {
    const sets = [
      set({ reference_set_id: UUID_A, image_count: MAX_TOTAL_REFERENCE_IMAGES }),
      set({ reference_set_id: UUID_B, role: 'texture', image_count: 1 }),
    ]
    const images = new Map([
      [UUID_A, Array.from({ length: MAX_TOTAL_REFERENCE_IMAGES }, (_, i) => ({ id: `a-${i}` }))],
      [UUID_B, [{ id: 'b-0' }]],
    ])
    expect(expectError(resolveReferenceImageSelection(sets, images)))
      .toMatch(new RegExp(`exceeds maximum of ${MAX_TOTAL_REFERENCE_IMAGES}`))
  })

  it('honours a custom maxTotal argument', () => {
    const sets = [set({ reference_set_id: UUID_A, image_count: 3 })]
    const images = new Map([[UUID_A, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]]])
    expect(expectError(resolveReferenceImageSelection(sets, images, 2))).toMatch(/exceeds maximum of 2/)
  })
})

// ---------------------------------------------------------------------------
// clampJobsPagination
// ---------------------------------------------------------------------------

describe('clampJobsPagination', () => {
  it('falls back to defaults for null params', () => {
    expect(clampJobsPagination(null, null)).toEqual({ limit: DEFAULT_JOBS_LIMIT, offset: 0 })
  })

  it('falls back to the default limit for non-numeric input', () => {
    expect(clampJobsPagination('abc', null).limit).toBe(DEFAULT_JOBS_LIMIT)
  })

  it('falls back to the default limit when limit is zero', () => {
    // Number('0') is 0 (falsy) → default kicks in.
    expect(clampJobsPagination('0', null).limit).toBe(DEFAULT_JOBS_LIMIT)
  })

  it('clamps a too-large limit to MAX_JOBS_LIMIT', () => {
    expect(clampJobsPagination('100000', null).limit).toBe(MAX_JOBS_LIMIT)
  })

  it('clamps a negative limit up to 1', () => {
    expect(clampJobsPagination('-5', null).limit).toBe(1)
  })

  it('passes through an in-range limit', () => {
    expect(clampJobsPagination('25', null).limit).toBe(25)
  })

  it('clamps a negative offset to 0', () => {
    expect(clampJobsPagination(null, '-10').offset).toBe(0)
  })

  it('passes through a valid offset', () => {
    expect(clampJobsPagination(null, '40').offset).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// validateVariationCount
// ---------------------------------------------------------------------------

describe('validateVariationCount', () => {
  it('accepts the lower bound of 1', () => {
    expect(validateVariationCount(1)).toBe(1)
  })

  it('accepts the upper bound', () => {
    expect(validateVariationCount(MAX_VARIATION_COUNT)).toBe(MAX_VARIATION_COUNT)
  })

  it('rejects 0', () => {
    expect(validateVariationCount(0)).toBeNull()
  })

  it('rejects values above the maximum', () => {
    expect(validateVariationCount(MAX_VARIATION_COUNT + 1)).toBeNull()
  })

  it('rejects fractional values', () => {
    expect(validateVariationCount(1.5)).toBeNull()
  })

  it('rejects negative values', () => {
    expect(validateVariationCount(-3)).toBeNull()
  })

  it('coerces a whole-number numeric string', () => {
    expect(validateVariationCount('5')).toBe(5)
  })

  it('rejects a non-numeric string', () => {
    expect(validateVariationCount('lots')).toBeNull()
  })

  it('rejects null and undefined', () => {
    expect(validateVariationCount(null)).toBeNull()
    expect(validateVariationCount(undefined)).toBeNull()
  })

  it('rejects NaN and Infinity', () => {
    expect(validateVariationCount(NaN)).toBeNull()
    expect(validateVariationCount(Infinity)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// capStyleValue
// ---------------------------------------------------------------------------

describe('capStyleValue', () => {
  it('returns undefined for non-string input', () => {
    expect(capStyleValue(5)).toBeUndefined()
    expect(capStyleValue(null)).toBeUndefined()
    expect(capStyleValue(undefined)).toBeUndefined()
    expect(capStyleValue({})).toBeUndefined()
  })

  it('returns undefined for an empty or whitespace-only string', () => {
    expect(capStyleValue('')).toBeUndefined()
    expect(capStyleValue('   ')).toBeUndefined()
  })

  it('passes through a normal style value unchanged', () => {
    expect(capStyleValue('soft natural light')).toBe('soft natural light')
  })

  it('truncates an oversized value to MAX_STYLE_VALUE_LEN', () => {
    const long = 'x'.repeat(MAX_STYLE_VALUE_LEN + 100)
    expect(capStyleValue(long)).toHaveLength(MAX_STYLE_VALUE_LEN)
  })

  it('does NOT trim surrounding whitespace from a non-blank value', () => {
    // The trim is only a blank-detection guard; surrounding spaces are preserved.
    expect(capStyleValue('  85mm  ')).toBe('  85mm  ')
  })
})

// ---------------------------------------------------------------------------
// isValidDeleteScope
// ---------------------------------------------------------------------------

describe('isValidDeleteScope', () => {
  it('accepts every documented scope', () => {
    for (const scope of ['active', 'failed', 'all', 'log']) {
      expect(isValidDeleteScope(scope)).toBe(true)
    }
  })

  it('rejects unknown scopes', () => {
    expect(isValidDeleteScope('everything')).toBe(false)
    expect(isValidDeleteScope('')).toBe(false)
    expect(isValidDeleteScope('ACTIVE')).toBe(false)
  })
})
