/**
 * Tests for src/lib/server-secrets.ts
 *
 * Covers: secretsEqual constant-time comparison and isAdminAuthorizedNode
 * header validation.  These functions guard every protected Node.js API route
 * (worker + admin endpoints), so correctness here is critical.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { NextRequest } from 'next/server'
import { isAdminAuthorizedNode, secretsEqual } from '@/lib/server-secrets'

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
