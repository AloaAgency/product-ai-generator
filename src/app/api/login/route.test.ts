/**
 * Tests for src/app/api/login/route.ts (the POST handler)
 *
 * Covers: fail-closed behaviour, correct/wrong password flows, open-redirect
 * prevention, and handling of malformed form inputs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'
import { POST } from '@/app/api/login/route'

const TEST_PASSWORD = 'login-route-test-password'

/** Build a NextRequest that simulates a login form POST. */
function buildLoginRequest(fields: Record<string, string | File>, baseUrl = 'http://localhost'): NextRequest {
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value)
  }
  return new NextRequest(`${baseUrl}/api/login`, {
    method: 'POST',
    body: formData,
  })
}

// ---------------------------------------------------------------------------
// Fail-closed — SITE_PASSWORD not configured
// ---------------------------------------------------------------------------

describe('POST /api/login — SITE_PASSWORD not configured', () => {
  beforeEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('returns 503 when SITE_PASSWORD is not set', async () => {
    const req = buildLoginRequest({ password: 'anything', redirect: '/' })
    const res = await POST(req)
    expect(res.status).toBe(503)
  })

  it('returns 503 even when the submitted password is empty', async () => {
    const req = buildLoginRequest({ password: '', redirect: '/' })
    const res = await POST(req)
    expect(res.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// Correct password — sets cookie and redirects to intended destination
// ---------------------------------------------------------------------------

describe('POST /api/login — correct password', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('returns a 303 redirect on correct password', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    expect(res.status).toBe(303)
  })

  it('sets the auth cookie with the correct HMAC token value', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    const expectedToken = await deriveAuthToken(TEST_PASSWORD)
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=${expectedToken}`)
  })

  it('sets the auth cookie as httpOnly', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie.toLowerCase()).toContain('httponly')
  })

  it('redirects to the provided redirect path on success', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/products/123' })
    const res = await POST(req)
    // NextResponse.redirect builds a full URL; extract just the pathname for comparison
    const location = res.headers.get('location') ?? ''
    const pathname = location.startsWith('http') ? new URL(location).pathname : location
    expect(pathname).toBe('/products/123')
  })

  it('redirects to / when no redirect path is provided', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD })
    const res = await POST(req)
    const location = res.headers.get('location') ?? ''
    const pathname = location.startsWith('http') ? new URL(location).pathname : location
    expect(pathname).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// Wrong password — redirects back with error flag, no cookie set
// ---------------------------------------------------------------------------

describe('POST /api/login — wrong password', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('returns 303 on wrong password', async () => {
    const req = buildLoginRequest({ password: 'wrong-password', redirect: '/' })
    const res = await POST(req)
    expect(res.status).toBe(303)
  })

  it('appends ?error=1 to the redirect location on wrong password', async () => {
    const req = buildLoginRequest({ password: 'wrong-password', redirect: '/dashboard' })
    const res = await POST(req)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('error=1')
    expect(location).toContain('/dashboard')
  })

  it('does NOT set an auth cookie on wrong password', async () => {
    const req = buildLoginRequest({ password: 'wrong-password', redirect: '/' })
    const res = await POST(req)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeNull()
  })

  it('does not expose whether the password was "close" — error param is always just "1"', async () => {
    const req = buildLoginRequest({ password: 'almost-right', redirect: '/' })
    const res = await POST(req)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/[?&]error=1(&|$)/)
  })
})

// ---------------------------------------------------------------------------
// Open-redirect prevention — redirect field validation
// ---------------------------------------------------------------------------

describe('POST /api/login — open-redirect prevention', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  /** Extract just the pathname from a Location header (handles both absolute and relative URLs). */
  function locationPathname(res: Response): string {
    const loc = res.headers.get('location') ?? ''
    return loc.startsWith('http') ? new URL(loc).pathname : loc
  }

  it('sanitises a protocol-relative URL (//evil.com) to / to prevent open redirect', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '//evil.com' })
    const res = await POST(req)
    expect(locationPathname(res)).toBe('/')
  })

  it('sanitises http:// absolute URL to / to prevent open redirect', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: 'http://evil.com' })
    const res = await POST(req)
    expect(locationPathname(res)).toBe('/')
  })

  it('sanitises https:// absolute URL to /', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: 'https://evil.com/steal' })
    const res = await POST(req)
    expect(locationPathname(res)).toBe('/')
  })

  it('preserves a safe relative path starting with /', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/products/abc/gallery' })
    const res = await POST(req)
    expect(locationPathname(res)).toBe('/products/abc/gallery')
  })

  it('preserves the root path / as-is', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    expect(locationPathname(res)).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// Malformed form inputs — robustness
// ---------------------------------------------------------------------------

describe('POST /api/login — malformed form inputs', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('treats a File object in the password field as an empty string (no crash)', async () => {
    // FormData accepts File objects; the route must not crash when a multipart
    // upload sends a file where a password string is expected.
    const formData = new FormData()
    formData.set('password', new File(['binary-payload'], 'exploit.bin', { type: 'application/octet-stream' }))
    formData.set('redirect', '/')
    const req = new NextRequest('http://localhost/api/login', { method: 'POST', body: formData })
    const res = await POST(req)
    // File treated as empty string → wrong password → 303 with error
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=1')
  })

  it('treats a File object in the redirect field as empty string and falls back to /', async () => {
    const formData = new FormData()
    formData.set('password', TEST_PASSWORD)
    formData.set('redirect', new File(['data'], 'redirect.txt', { type: 'text/plain' }))
    const req = new NextRequest('http://localhost/api/login', { method: 'POST', body: formData })
    const res = await POST(req)
    expect(res.status).toBe(303)
    const loc = res.headers.get('location') ?? ''
    const pathname = loc.startsWith('http') ? new URL(loc).pathname : loc
    expect(pathname).toBe('/')
  })

  it('falls back to / when redirect field is absent from the form', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    const pathname = loc.startsWith('http') ? new URL(loc).pathname : loc
    expect(pathname).toBe('/')
  })
})
