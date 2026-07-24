/**
 * Tests for src/app/api/login/route.ts (the POST handler)
 *
 * Covers: fail-closed behaviour, correct/wrong password flows, open-redirect
 * prevention, and handling of malformed form inputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'
import { GET, POST } from '@/app/api/login/route'

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
// GET — direct browser navigation redirects home instead of 405
// ---------------------------------------------------------------------------

describe('GET /api/login — direct navigation', () => {
  it('redirects to / with 303 instead of returning 405', () => {
    const req = new NextRequest('http://localhost/api/login')
    const res = GET(req)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    const pathname = location.startsWith('http') ? new URL(location).pathname : location
    expect(pathname).toBe('/')
  })

  it('does not set an auth cookie', () => {
    const req = new NextRequest('http://localhost/api/login')
    const res = GET(req)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

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

  it('serves a human-readable HTML error page, not a blank response — this answers a browser form POST', async () => {
    const req = buildLoginRequest({ password: 'anything', redirect: '/' })
    const res = await POST(req)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('Sign-in unavailable')
    expect(html).toContain('href="/"') // way back to the login gate
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

  it('sets the auth cookie with Secure, SameSite=Lax, and the intentional app-wide path', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    const normalized = setCookie.toLowerCase()

    expect(normalized).toContain('secure')
    expect(normalized).toContain('samesite=lax')
    expect(setCookie).toContain('Path=/')
  })

  it('satisfies the __Host- prefix preconditions (no Domain attribute)', async () => {
    // Browsers reject a __Host- cookie carrying a Domain attribute (or missing
    // Secure / Path=/, pinned above). If this assertion fails, the cookie would
    // be silently dropped by every browser and nobody could log in.
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie.toLowerCase()).not.toContain('domain=')
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

  it('sanitises a backslash path (/\\evil.com) to / — URL parser treats \\ as / making it protocol-relative', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/\\evil.com' })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('evil.com')
    expect(locationPathname(res)).toBe('/')
  })

  it('sanitises a tab-smuggled path (/\\t/evil.com) to / — URL parser strips tabs making it protocol-relative', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/\t/evil.com' })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('evil.com')
    expect(locationPathname(res)).toBe('/')
  })

  it('sanitises a newline-smuggled path (/\\n/evil.com) to /', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/\n/evil.com' })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('evil.com')
    expect(locationPathname(res)).toBe('/')
  })

  it('sanitises a double-backslash path (/\\\\evil.com) to /', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/\\\\evil.com' })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('evil.com')
    expect(locationPathname(res)).toBe('/')
  })

  it('preserves the query string of a safe relative redirect', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/products/123?view=grid&page=2' })
    const res = await POST(req)
    const loc = res.headers.get('location') ?? ''
    const url = loc.startsWith('http') ? new URL(loc) : new URL(loc, 'http://localhost')
    expect(url.pathname).toBe('/products/123')
    expect(url.searchParams.get('view')).toBe('grid')
    expect(url.searchParams.get('page')).toBe('2')
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
// Input length limits — DoS protection
// ---------------------------------------------------------------------------

describe('POST /api/login — input length limits', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('returns 400 when the password field exceeds 1024 bytes', async () => {
    const oversizedPassword = 'a'.repeat(1025)
    const req = buildLoginRequest({ password: oversizedPassword, redirect: '/' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('serves a human-readable HTML error page on the 400, not a blank response', async () => {
    const req = buildLoginRequest({ password: 'a'.repeat(1025), redirect: '/' })
    const res = await POST(req)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Invalid request')
    expect(html).toContain('href="/"')
  })

  it('accepts a password exactly at the 1024-byte limit', async () => {
    const atLimit = 'a'.repeat(1024)
    const req = buildLoginRequest({ password: atLimit, redirect: '/' })
    const res = await POST(req)
    // Wrong password → 303 with error, but NOT a 400 (no limit rejection)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=1')
  })

  it('truncates a redirect path longer than 2048 characters', async () => {
    const longRedirect = '/products/' + 'a'.repeat(2100)
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: longRedirect })
    const res = await POST(req)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    const pathname = location.startsWith('http') ? new URL(location).pathname : location.split('?')[0]
    expect(pathname.length).toBeLessThanOrEqual(2048)
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

// ---------------------------------------------------------------------------
// Cache-control — auth responses must never be cached by a shared proxy
// ---------------------------------------------------------------------------

describe('POST /api/login — no-store on auth responses', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('sets Cache-Control: no-store on the success redirect carrying the Set-Cookie', async () => {
    const req = buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' })
    const res = await POST(req)
    expect(res.headers.get('set-cookie')).toContain(AUTH_COOKIE_NAME)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('sets Cache-Control: no-store on the wrong-password redirect', async () => {
    const req = buildLoginRequest({ password: 'nope', redirect: '/' })
    const res = await POST(req)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('sets Cache-Control: no-store on the GET redirect', () => {
    const res = GET(new NextRequest('http://localhost/api/login'))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

// ---------------------------------------------------------------------------
// Configurable session TTL — SITE_AUTH_TTL_DAYS
// ---------------------------------------------------------------------------

describe('POST /api/login — configurable session TTL', () => {
  beforeEach(() => {
    process.env.SITE_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
    delete process.env.SITE_AUTH_TTL_DAYS
  })

  /** Extract the cookie Max-Age (seconds) from a Set-Cookie header. */
  function cookieMaxAge(res: Response): number | null {
    const setCookie = res.headers.get('set-cookie') ?? ''
    const match = setCookie.match(/Max-Age=(\d+)/i)
    return match ? Number(match[1]) : null
  }

  it('defaults to a 7-day cookie when SITE_AUTH_TTL_DAYS is unset', async () => {
    const res = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(cookieMaxAge(res)).toBe(7 * 24 * 60 * 60)
  })

  it('honours a configured SITE_AUTH_TTL_DAYS value', async () => {
    process.env.SITE_AUTH_TTL_DAYS = '2'
    const res = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(cookieMaxAge(res)).toBe(2 * 24 * 60 * 60)
  })

  it('falls back to the 7-day default for invalid SITE_AUTH_TTL_DAYS values', async () => {
    process.env.SITE_AUTH_TTL_DAYS = 'not-a-number'
    const res = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(cookieMaxAge(res)).toBe(7 * 24 * 60 * 60)
  })

  it('clamps an absurdly large SITE_AUTH_TTL_DAYS to the 365-day maximum', async () => {
    process.env.SITE_AUTH_TTL_DAYS = '100000'
    const res = await POST(buildLoginRequest({ password: TEST_PASSWORD, redirect: '/' }))
    expect(cookieMaxAge(res)).toBe(365 * 24 * 60 * 60)
  })
})

// ---------------------------------------------------------------------------
// Brute-force rate limiting — 429 after the configured failure cap
//
// Uses a fresh module instance (vi.resetModules + dynamic import) with a low
// LOGIN_MAX_FAILED_ATTEMPTS so the singleton limiter is built with a tiny cap,
// keeping the test fast and isolated from the statically-imported route.
// ---------------------------------------------------------------------------

describe('POST /api/login — brute-force rate limiting', () => {
  afterEach(() => {
    delete process.env.SITE_PASSWORD
    delete process.env.LOGIN_MAX_FAILED_ATTEMPTS
    vi.resetModules()
  })

  /** POST a login request carrying an explicit client IP so the limiter keys on it. */
  function attempt(post: typeof POST, password: string, ip: string) {
    const formData = new FormData()
    formData.set('password', password)
    formData.set('redirect', '/')
    const req = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: formData,
      headers: { 'x-forwarded-for': ip },
    })
    return post(req)
  }

  it('returns 429 with a Retry-After header once the failed-attempt cap is exceeded', async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    process.env.LOGIN_MAX_FAILED_ATTEMPTS = '2'
    const { POST: freshPost } = await import('@/app/api/login/route')

    const ip = '203.0.113.50'
    // Two wrong-password attempts reach the cap...
    expect((await attempt(freshPost, 'wrong', ip)).status).toBe(303)
    expect((await attempt(freshPost, 'wrong', ip)).status).toBe(303)
    // ...the next attempt is throttled before the password is even checked.
    const throttled = await attempt(freshPost, 'wrong', ip)
    expect(throttled.status).toBe(429)
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(throttled.headers.get('cache-control')).toBe('no-store')
  })

  it('serves a human-readable HTML error page on the 429 telling the user when to retry', async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    process.env.LOGIN_MAX_FAILED_ATTEMPTS = '1'
    const { POST: freshPost } = await import('@/app/api/login/route')

    const ip = '203.0.113.53'
    await attempt(freshPost, 'wrong', ip)
    const throttled = await attempt(freshPost, 'wrong', ip)
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('content-type')).toContain('text/html')
    const html = await throttled.text()
    expect(html).toContain('Too many')
    expect(html).toMatch(/in about \d+ minutes?/)
    expect(html).toContain('href="/"')
  })

  it('does not throttle a different client IP', async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    process.env.LOGIN_MAX_FAILED_ATTEMPTS = '2'
    const { POST: freshPost } = await import('@/app/api/login/route')

    await attempt(freshPost, 'wrong', '203.0.113.51')
    await attempt(freshPost, 'wrong', '203.0.113.51')
    // A clean IP is unaffected by another client's failures.
    expect((await attempt(freshPost, 'wrong', '203.0.113.99')).status).toBe(303)
  })

  it('a correct password clears the counter, so a later attempt is not throttled', async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    process.env.LOGIN_MAX_FAILED_ATTEMPTS = '2'
    const { POST: freshPost } = await import('@/app/api/login/route')

    const ip = '203.0.113.52'
    await attempt(freshPost, 'wrong', ip)
    // Correct password resets the bucket.
    expect((await attempt(freshPost, TEST_PASSWORD, ip)).status).toBe(303)
    // Two fresh failures are needed again before throttling resumes.
    expect((await attempt(freshPost, 'wrong', ip)).status).toBe(303)
    expect((await attempt(freshPost, 'wrong', ip)).status).toBe(303)
    expect((await attempt(freshPost, 'wrong', ip)).status).toBe(429)
  })
})
