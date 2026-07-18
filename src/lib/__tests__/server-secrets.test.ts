/**
 * Tests for src/lib/server-secrets.ts
 *
 * Covers: secretsEqual constant-time comparison and isAdminAuthorizedNode
 * header validation.  These functions guard every protected Node.js API route
 * (worker + admin endpoints), so correctness here is critical.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { NextRequest } from 'next/server'
import { isAdminAuthorizedNode, matchesRotatableSecret, secretsEqual } from '@/lib/server-secrets'

// ---------------------------------------------------------------------------
// secretsEqual — constant-time string comparison
// ---------------------------------------------------------------------------

describe('secretsEqual', () => {
  it('returns true for identical strings', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for strings that differ by one character', () => {
    expect(secretsEqual('abX', 'abc')).toBe(false)
  })

  it('returns false when a is longer than b', () => {
    expect(secretsEqual('abcd', 'abc')).toBe(false)
  })

  it('returns false when a is shorter than b', () => {
    expect(secretsEqual('ab', 'abc')).toBe(false)
  })

  it('returns false for empty string vs non-empty string', () => {
    expect(secretsEqual('', 'secret')).toBe(false)
  })

  it('returns false for non-empty string vs empty string', () => {
    expect(secretsEqual('secret', '')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(secretsEqual('', '')).toBe(true)
  })

  it('is case-sensitive — strings differing only by case are rejected', () => {
    expect(secretsEqual('Secret', 'secret')).toBe(false)
  })

  it('returns true for a long matching secret (256-char)', () => {
    const s = 'x'.repeat(256)
    expect(secretsEqual(s, s)).toBe(true)
  })

  it('returns false for a long string where only the last character differs', () => {
    // Verifies the comparison does not short-circuit on an early match.
    const a = 'x'.repeat(63) + 'A'
    const b = 'x'.repeat(63) + 'B'
    expect(secretsEqual(a, b)).toBe(false)
  })

  it('handles strings with multi-byte UTF-8 characters', () => {
    expect(secretsEqual('pässwörd', 'pässwörd')).toBe(true)
    expect(secretsEqual('pässwörd', 'password')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isAdminAuthorizedNode — x-admin-secret header validation (Node.js)
// ---------------------------------------------------------------------------

/** Build a minimal NextRequest-compatible stub for testing header inspection. */
function mockRequest(headers: Record<string, string>): NextRequest {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest
}

describe('isAdminAuthorizedNode', () => {
  const originalAdminSecret = process.env.ADMIN_SECRET

  afterEach(() => {
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret
    }
  })

  it('returns false when ADMIN_SECRET is not configured — fails closed', () => {
    delete process.env.ADMIN_SECRET
    const req = mockRequest({ 'x-admin-secret': 'anything' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('returns false when the x-admin-secret header is absent', () => {
    process.env.ADMIN_SECRET = 'configured-secret'
    const req = mockRequest({})
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('returns false when the x-admin-secret header is empty', () => {
    process.env.ADMIN_SECRET = 'configured-secret'
    const req = mockRequest({ 'x-admin-secret': '' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('returns true when x-admin-secret header exactly matches ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'my-admin-secret'
    const req = mockRequest({ 'x-admin-secret': 'my-admin-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(true)
  })

  it('returns false when x-admin-secret header does not match ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'correct-secret'
    const req = mockRequest({ 'x-admin-secret': 'wrong-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('is case-sensitive — a header differing only in case is rejected', () => {
    process.env.ADMIN_SECRET = 'Secret123'
    const req = mockRequest({ 'x-admin-secret': 'secret123' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('returns false for empty ADMIN_SECRET even if header is also empty — fails closed', () => {
    // ADMIN_SECRET='' is falsy — the function must still deny all requests.
    process.env.ADMIN_SECRET = ''
    const req = mockRequest({ 'x-admin-secret': '' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchesRotatableSecret — rotation overlap acceptance
// ---------------------------------------------------------------------------

describe('matchesRotatableSecret', () => {
  it('accepts the current secret', () => {
    expect(matchesRotatableSecret('current', 'current')).toBe(true)
  })

  it('accepts the previous secret during a rotation overlap', () => {
    expect(matchesRotatableSecret('old', 'new', 'old')).toBe(true)
  })

  it('still accepts the current secret while a previous secret is set', () => {
    expect(matchesRotatableSecret('new', 'new', 'old')).toBe(true)
  })

  it('rejects a wrong value even when both current and previous are set', () => {
    expect(matchesRotatableSecret('wrong', 'new', 'old')).toBe(false)
  })

  it('fails closed when the current secret is undefined, even if previous matches', () => {
    // A *_PREVIOUS value alone must never grant access.
    expect(matchesRotatableSecret('old', undefined, 'old')).toBe(false)
  })

  it('fails closed when the current secret is empty, even if previous matches', () => {
    expect(matchesRotatableSecret('old', '', 'old')).toBe(false)
  })

  it('rejects an empty provided value even if the previous secret is empty', () => {
    expect(matchesRotatableSecret('', 'current', '')).toBe(false)
  })

  it('rejects when previous is unset and provided does not match current', () => {
    expect(matchesRotatableSecret('old', 'new')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isAdminAuthorizedNode — ADMIN_SECRET_PREVIOUS rotation overlap
// ---------------------------------------------------------------------------

describe('isAdminAuthorizedNode — rotation overlap', () => {
  const originalAdminSecret = process.env.ADMIN_SECRET
  const originalPrevious = process.env.ADMIN_SECRET_PREVIOUS

  afterEach(() => {
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret
    }
    if (originalPrevious === undefined) {
      delete process.env.ADMIN_SECRET_PREVIOUS
    } else {
      process.env.ADMIN_SECRET_PREVIOUS = originalPrevious
    }
  })

  it('accepts the previous secret while ADMIN_SECRET_PREVIOUS is set', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'old-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(true)
  })

  it('accepts the new secret while ADMIN_SECRET_PREVIOUS is set', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'new-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(true)
  })

  it('rejects the previous secret once ADMIN_SECRET_PREVIOUS is removed', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    delete process.env.ADMIN_SECRET_PREVIOUS
    const req = mockRequest({ 'x-admin-secret': 'old-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })

  it('fails closed when only ADMIN_SECRET_PREVIOUS is configured', () => {
    delete process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'old-secret' })
    expect(isAdminAuthorizedNode(req)).toBe(false)
  })
})
