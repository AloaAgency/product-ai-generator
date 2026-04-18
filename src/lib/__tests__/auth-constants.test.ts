import { afterEach, describe, expect, it } from 'vitest'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken, isAdminAuthorized } from '@/lib/auth-constants'

// ---------------------------------------------------------------------------
// AUTH_COOKIE_NAME — constant guard
// ---------------------------------------------------------------------------

describe('AUTH_COOKIE_NAME', () => {
  it('equals "site-auth" — changing this constant invalidates all live auth cookies', () => {
    expect(AUTH_COOKIE_NAME).toBe('site-auth')
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
