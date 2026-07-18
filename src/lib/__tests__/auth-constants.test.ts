import { afterEach, describe, expect, it } from 'vitest'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken, isAdminAuthorized, timingResistantEqual } from '@/lib/auth-constants'

// ---------------------------------------------------------------------------
// timingResistantEqual — XOR-based constant-time comparison (Edge Runtime)
// ---------------------------------------------------------------------------

describe('timingResistantEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingResistantEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for strings that differ by one character', () => {
    expect(timingResistantEqual('abX', 'abc')).toBe(false)
  })

  it('returns false when provided is longer than expected', () => {
    expect(timingResistantEqual('abcd', 'abc')).toBe(false)
  })

  it('returns false when provided is shorter than expected', () => {
    expect(timingResistantEqual('ab', 'abc')).toBe(false)
  })

  it('returns false for empty provided vs non-empty expected', () => {
    // Empty provided must not pass — previously relied on NaN→0 coercion in bitwise XOR;
    // explicit bounds check (i < pLen ? charCodeAt(i) : 0) makes this unambiguous.
    expect(timingResistantEqual('', 'secret')).toBe(false)
  })

  it('returns false for empty provided vs expected containing only null bytes', () => {
    // Regression: null-byte expected could trivially XOR to 0 with a dummy value;
    // the length-mismatch flag (diff = 1) must prevent a false positive.
    expect(timingResistantEqual('', '\x00\x00\x00')).toBe(false)
  })

  it('returns false for non-empty provided vs empty expected', () => {
    expect(timingResistantEqual('secret', '')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(timingResistantEqual('', '')).toBe(true)
  })

  it('is case-sensitive — strings differing only in case are rejected', () => {
    expect(timingResistantEqual('Secret', 'secret')).toBe(false)
  })

  it('returns true for a long matching string (64-char HMAC-hex)', () => {
    const s64 = 'f'.repeat(64)
    expect(timingResistantEqual(s64, s64)).toBe(true)
  })

  it('returns false when provided is a prefix repetition of expected (guards against wrap-around false positive)', () => {
    // If provided = "abc" and expected = "abcabc", a naive wrap-around XOR
    // could produce all-zero differences and wrongly return true.
    // The length-mismatch flag must prevent this.
    expect(timingResistantEqual('abc', 'abcabc')).toBe(false)
  })

  it('returns false for a 64-char string where only the last character differs', () => {
    const a = 'f'.repeat(63) + 'a'
    const b = 'f'.repeat(63) + 'b'
    expect(timingResistantEqual(a, b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AUTH_COOKIE_NAME — constant guard
// ---------------------------------------------------------------------------

describe('AUTH_COOKIE_NAME', () => {
  it('equals "__Host-site-auth" — changing this constant invalidates all live auth cookies', () => {
    expect(AUTH_COOKIE_NAME).toBe('__Host-site-auth')
  })

  it('keeps the __Host- prefix so browsers enforce Secure + Path=/ + no Domain', () => {
    // The prefix is load-bearing: browsers reject a __Host- cookie set without
    // Secure/Path=/ or with a Domain attribute, which turns any future weakening
    // of the login route's cookie options into a hard failure instead of a
    // silently less-secure session cookie.
    expect(AUTH_COOKIE_NAME.startsWith('__Host-')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// deriveAuthToken — HMAC-SHA256 derivation
// ---------------------------------------------------------------------------

describe('deriveAuthToken', () => {
  it('returns a lowercase hex string', async () => {
    const token = await deriveAuthToken('any-password')
    expect(token).toMatch(/^[0-9a-f]+$/)
  })

  it('returns exactly 64 hex characters (HMAC-SHA256 = 32 bytes = 64 hex chars)', async () => {
    const token = await deriveAuthToken('any-password')
    expect(token).toHaveLength(64)
  })

  it('is deterministic — same password always produces the same token', async () => {
    const first = await deriveAuthToken('stable-password')
    const second = await deriveAuthToken('stable-password')
    expect(first).toBe(second)
  })

  it('produces different tokens for different passwords (no collisions on distinct inputs)', async () => {
    const a = await deriveAuthToken('password-alpha')
    const b = await deriveAuthToken('password-beta')
    expect(a).not.toBe(b)
  })

  it('regression guard — token for "regression-pw" must match the hardcoded HMAC-SHA256 value', async () => {
    // IMPORTANT: If this test fails, the derivation algorithm changed and every
    // active auth cookie in production has been silently invalidated. Only update
    // this expected value intentionally, as part of a coordinated session reset.
    // Value: HMAC-SHA256(key="regression-pw", message="site-auth-v1") = hex digest
    const expected = 'ee5f4f8d5b3a41d1ac45d52d364a1d08ddda0c482374500d1efd39619b34941d'
    const actual = await deriveAuthToken('regression-pw')
    expect(actual).toBe(expected)
  })

  it('handles passwords with special characters', async () => {
    const token = await deriveAuthToken('p@$$w0rd!#%^&*()')
    expect(token).toHaveLength(64)
    expect(token).toMatch(/^[0-9a-f]+$/)
  })

  it('handles a single-character password', async () => {
    const token = await deriveAuthToken('x')
    expect(token).toHaveLength(64)
    expect(token).toMatch(/^[0-9a-f]+$/)
  })
})

// ---------------------------------------------------------------------------
// isAdminAuthorized — x-admin-secret header validation
// ---------------------------------------------------------------------------

/** Build a minimal NextRequest-compatible stub for testing header inspection. */
function mockRequest(headers: Record<string, string>): NextRequest {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest
}

describe('isAdminAuthorized', () => {
  const originalAdminSecret = process.env.ADMIN_SECRET

  afterEach(() => {
    // Restore ADMIN_SECRET after each test to prevent test pollution.
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret
    }
  })

  it('returns false when ADMIN_SECRET is not configured — fails closed', () => {
    delete process.env.ADMIN_SECRET
    const req = mockRequest({ 'x-admin-secret': 'anything' })
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('returns false when the x-admin-secret header is absent', () => {
    process.env.ADMIN_SECRET = 'configured-secret'
    const req = mockRequest({})  // no x-admin-secret header present
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('returns true when x-admin-secret header exactly matches ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'my-admin-secret'
    const req = mockRequest({ 'x-admin-secret': 'my-admin-secret' })
    expect(isAdminAuthorized(req)).toBe(true)
  })

  it('returns false when x-admin-secret header does not match ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'correct-secret'
    const req = mockRequest({ 'x-admin-secret': 'wrong-secret' })
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('is case-sensitive — a header differing only in case is rejected', () => {
    process.env.ADMIN_SECRET = 'Secret123'
    const req = mockRequest({ 'x-admin-secret': 'secret123' })
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('returns false for an empty-string header even if ADMIN_SECRET is also empty', () => {
    // ADMIN_SECRET='' is falsy — the function must still fail closed.
    process.env.ADMIN_SECRET = ''
    const req = mockRequest({ 'x-admin-secret': '' })
    expect(isAdminAuthorized(req)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isAdminAuthorized — ADMIN_SECRET_PREVIOUS rotation overlap (Edge variant)
// ---------------------------------------------------------------------------

describe('isAdminAuthorized — rotation overlap', () => {
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
    expect(isAdminAuthorized(req)).toBe(true)
  })

  it('accepts the new secret while ADMIN_SECRET_PREVIOUS is set', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'new-secret' })
    expect(isAdminAuthorized(req)).toBe(true)
  })

  it('rejects the previous secret once ADMIN_SECRET_PREVIOUS is removed', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    delete process.env.ADMIN_SECRET_PREVIOUS
    const req = mockRequest({ 'x-admin-secret': 'old-secret' })
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('fails closed when only ADMIN_SECRET_PREVIOUS is configured', () => {
    delete process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'old-secret' })
    expect(isAdminAuthorized(req)).toBe(false)
  })

  it('rejects a wrong value while both secrets are set', () => {
    process.env.ADMIN_SECRET = 'new-secret'
    process.env.ADMIN_SECRET_PREVIOUS = 'old-secret'
    const req = mockRequest({ 'x-admin-secret': 'neither' })
    expect(isAdminAuthorized(req)).toBe(false)
  })
})
