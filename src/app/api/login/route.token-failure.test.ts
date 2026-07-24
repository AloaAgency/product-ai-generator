/**
 * Tests for the token-derivation failure paths in src/app/api/login/route.ts
 *
 * The route caches the deriveAuthToken() Promise in module state and awaits it
 * on the success path. Two resilience contracts are pinned here:
 *   1. A derivation failure on a correct-password login returns a structured
 *      503 (matching the missing-SITE_PASSWORD signal), not an opaque 500.
 *   2. The rejected Promise is not cached forever — once derivation recovers,
 *      the next correct-password login succeeds and sets the auth cookie.
 *
 * Kept separate from route.test.ts because these tests must mock
 * @/lib/auth-constants and re-import the route module, while route.test.ts
 * imports both statically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const TEST_PASSWORD = 'login-token-failure-test-password'

function buildLoginRequest(fields: Record<string, string>): NextRequest {
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value)
  }
  return new NextRequest('http://localhost/api/login', {
    method: 'POST',
    body: formData,
  })
}

describe('POST /api/login — transient token-derivation failure', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth-constants')
    vi.resetModules()
    delete process.env.SITE_PASSWORD
  })

  it('returns 503 while derivation fails, then recovers and sets the cookie', async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    const actual = await vi.importActual<typeof import('@/lib/auth-constants')>('@/lib/auth-constants')
    let failing = true
    vi.doMock('@/lib/auth-constants', () => ({
      ...actual,
      deriveAuthToken: async (password: string) => {
        if (failing) throw new Error('transient web crypto failure')
        return actual.deriveAuthToken(password)
      },
    }))
    const { POST } = await import('@/app/api/login/route')

    // Correct password, but the cookie token cannot be derived → 503, no cookie.
    const during = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(during.status).toBe(503)
    expect(during.headers.get('set-cookie')).toBeNull()

    // Derivation recovers: the earlier rejection must not have been cached, so
    // the same login now succeeds end-to-end.
    failing = false
    const after = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(after.status).toBe(303)
    const cookie = after.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`__Host-site-auth=${await actual.deriveAuthToken(TEST_PASSWORD)}`)
  })
})
