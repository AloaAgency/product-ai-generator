import { describe, it, expect } from 'vitest'

import {
  isValidGenerationJobId,
  parseWorkerPositiveInteger,
  sanitizeWorkerErrorMessage,
  MAX_GENERATION_BATCH_SIZE,
  MAX_GENERATION_PARALLELISM,
} from '../generation-worker-guards'

// ---------------------------------------------------------------------------
// isValidGenerationJobId — UUID v4 format gate
// ---------------------------------------------------------------------------

describe('isValidGenerationJobId', () => {
  it('accepts canonical lowercase UUID v4', () => {
    expect(isValidGenerationJobId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('accepts UUID v4 with uppercase hex digits', () => {
    // The regex uses the /i flag so casing must not matter.
    expect(isValidGenerationJobId('550E8400-E29B-41D4-A716-446655440000')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidGenerationJobId('')).toBe(false)
  })

  it('rejects a bare integer', () => {
    expect(isValidGenerationJobId('12345')).toBe(false)
  })

  it('rejects a UUID with extra characters appended (path traversal / injection)', () => {
    expect(isValidGenerationJobId('550e8400-e29b-41d4-a716-446655440000 DROP TABLE')).toBe(false)
    expect(isValidGenerationJobId('550e8400-e29b-41d4-a716-446655440000/../etc/passwd')).toBe(false)
  })

  it('rejects a UUID missing one segment', () => {
    expect(isValidGenerationJobId('550e8400-e29b-41d4-a716')).toBe(false)
  })

  it('rejects a UUID with a wrong version nibble (version 0)', () => {
    // Version nibble at position 14 must be 1-5.
    expect(isValidGenerationJobId('550e8400-e29b-01d4-a716-446655440000')).toBe(false)
  })

  it('rejects a UUID with a wrong variant nibble (must start 8, 9, a, or b)', () => {
    // Variant bits: 4th segment must start with 8-b.
    expect(isValidGenerationJobId('550e8400-e29b-41d4-c716-446655440000')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseWorkerPositiveInteger — safe integer parsing with clamping
// ---------------------------------------------------------------------------

describe('parseWorkerPositiveInteger', () => {
  it('returns the parsed integer when the input is a valid positive string', () => {
    expect(parseWorkerPositiveInteger('5', 1)).toBe(5)
    expect(parseWorkerPositiveInteger('100', 1)).toBe(100)
  })

  it('returns the parsed integer when the input is already a number', () => {
    expect(parseWorkerPositiveInteger(10, 1)).toBe(10)
  })

  it('returns the fallback for null', () => {
    expect(parseWorkerPositiveInteger(null, 7)).toBe(7)
  })

  it('returns the fallback for undefined', () => {
    expect(parseWorkerPositiveInteger(undefined, 3)).toBe(3)
  })

  it('returns the fallback for NaN', () => {
    expect(parseWorkerPositiveInteger('not-a-number', 2)).toBe(2)
    expect(parseWorkerPositiveInteger(NaN, 2)).toBe(2)
  })

  it('returns the fallback for zero (below default min of 1)', () => {
    expect(parseWorkerPositiveInteger('0', 5)).toBe(5)
    expect(parseWorkerPositiveInteger(0, 5)).toBe(5)
  })

  it('returns the fallback for negative numbers', () => {
    expect(parseWorkerPositiveInteger('-1', 4)).toBe(4)
    expect(parseWorkerPositiveInteger(-10, 4)).toBe(4)
  })

  it('returns the fallback for non-integer floats (not safe integers)', () => {
    // 1.5 is not an integer, so it should fall back.
    expect(parseWorkerPositiveInteger(1.5, 9)).toBe(9)
    expect(parseWorkerPositiveInteger('3.7', 9)).toBe(9)
  })

  it('clamps the result to the provided max', () => {
    expect(parseWorkerPositiveInteger('999', 1, { max: MAX_GENERATION_BATCH_SIZE })).toBe(MAX_GENERATION_BATCH_SIZE)
    expect(parseWorkerPositiveInteger('20', 1, { max: MAX_GENERATION_PARALLELISM })).toBe(MAX_GENERATION_PARALLELISM)
  })

  it('respects a custom min option', () => {
    // Value 3 is below min=5, so fallback is returned.
    expect(parseWorkerPositiveInteger('3', 10, { min: 5 })).toBe(10)
    // Value 5 equals min=5, so it passes.
    expect(parseWorkerPositiveInteger('5', 10, { min: 5 })).toBe(5)
  })

  it('returns the fallback for Infinity (not a safe integer)', () => {
    expect(parseWorkerPositiveInteger(Infinity, 8)).toBe(8)
    expect(parseWorkerPositiveInteger(-Infinity, 8)).toBe(8)
  })

  it('returns the fallback for Number.MAX_SAFE_INTEGER + 1 (unsafe integer)', () => {
    expect(parseWorkerPositiveInteger(Number.MAX_SAFE_INTEGER + 1, 6)).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// sanitizeWorkerErrorMessage — credential redaction and length enforcement
// ---------------------------------------------------------------------------

describe('sanitizeWorkerErrorMessage', () => {
  it('returns a plain message unchanged when there is nothing sensitive', () => {
    expect(sanitizeWorkerErrorMessage(new Error('Image generation failed'))).toBe('Image generation failed')
  })

  it('redacts Bearer tokens from error messages', () => {
    const err = new Error('Unauthorized: Bearer sk-abc123xyz')
    const safe = sanitizeWorkerErrorMessage(err)
    expect(safe).not.toContain('sk-abc123xyz')
    expect(safe).toContain('[redacted]')
  })

  it('redacts api_key values appearing in query strings', () => {
    const err = new Error('Request failed: https://api.example.com?api_key=secret-key-value')
    const safe = sanitizeWorkerErrorMessage(err)
    expect(safe).not.toContain('secret-key-value')
    expect(safe).toContain('[redacted]')
  })

  it('redacts secret= and token= header-style key-value pairs', () => {
    const err = new Error('Config error: secret=my-secret-value')
    const safe = sanitizeWorkerErrorMessage(err)
    expect(safe).not.toContain('my-secret-value')
    expect(safe).toContain('[redacted]')
  })

  it('redacts authorization header values', () => {
    const err = new Error('authorization: Bearer token-abc')
    const safe = sanitizeWorkerErrorMessage(err)
    expect(safe).not.toContain('token-abc')
    expect(safe).toContain('[redacted]')
  })

  it('returns the fallback string when the error is null', () => {
    expect(sanitizeWorkerErrorMessage(null)).toBe('Worker error')
    expect(sanitizeWorkerErrorMessage(null, 'Custom fallback')).toBe('Custom fallback')
  })

  it('returns the fallback string when the error is undefined', () => {
    expect(sanitizeWorkerErrorMessage(undefined)).toBe('Worker error')
  })

  it('returns the fallback when the error is an empty string', () => {
    expect(sanitizeWorkerErrorMessage('')).toBe('Worker error')
  })

  it('uses String(error) for Error objects with an empty message (gives "Error")', () => {
    // Error with no message: `error.message` is falsy so the function falls through
    // to String(error) which yields "Error". This is intentional — the Error class
    // itself is a useful signal even without a message.
    expect(sanitizeWorkerErrorMessage(new Error(''))).toBe('Error')
  })

  it('truncates messages longer than 500 characters with an ellipsis', () => {
    const longErr = new Error('x'.repeat(600))
    const safe = sanitizeWorkerErrorMessage(longErr)
    expect(safe.length).toBe(500)
    expect(safe.endsWith('...')).toBe(true)
  })

  it('does not truncate messages at exactly 500 characters', () => {
    const exact = new Error('x'.repeat(500))
    const safe = sanitizeWorkerErrorMessage(exact)
    expect(safe.length).toBe(500)
    expect(safe.endsWith('...')).toBe(false)
  })

  it('handles plain string errors (not Error objects)', () => {
    expect(sanitizeWorkerErrorMessage('Something broke')).toBe('Something broke')
  })

  it('coerces non-string, non-Error values to strings', () => {
    // Object converted via String() produces "[object Object]"
    const result = sanitizeWorkerErrorMessage({ code: 500 })
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('collapses multiple whitespace into a single space', () => {
    const err = new Error('something   went\n\t wrong')
    expect(sanitizeWorkerErrorMessage(err)).toBe('something went wrong')
  })
})
