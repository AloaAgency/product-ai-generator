/**
 * Tests for src/middleware.ts
 *
 * Strategy: each test resets the module registry with vi.resetModules() then
 * re-imports middleware via a dynamic import. This is necessary because
 * middleware.ts caches the derived HMAC token in module-level state
 * (`_cachedExpectedToken`); without resetting, a token cached by an earlier
 * test would persist and cause false positives or negatives in later tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { deriveAuthToken } from '@/lib/auth-constants'

// A stable password used across all middleware tests so the cached HMAC is
// consistent within each test (reset by vi.resetModules() between tests).
const TEST_PASSWORD = 'middleware-test-password'

type MiddlewareFn = (req: NextRequest) => Promise<Response>

async function importMiddleware(): Promise<MiddlewareFn> {
  const mod = await import('@/middleware')
  return mod.middleware
}

// ---------------------------------------------------------------------------
// Public path bypass — routes that skip site-password auth entirely
// ---------------------------------------------------------------------------

describe('middleware — public paths bypass auth', () => {
  let middleware: MiddlewareFn

  beforeEach(async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    middleware = await importMiddleware()
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('allows unauthenticated requests to /api/login — users must be able to submit credentials', async () => {
    const req = new NextRequest('http://localhost/api/login', { method: 'POST' })
    const res = await middleware(req)
    // NextResponse.next() sets x-middleware-next: 1 — confirms the request was passed through
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('allows unauthenticated requests to /api/worker/generate — worker uses its own auth', async () => {
    const req = new NextRequest('http://localhost/api/worker/generate')
    const res = await middleware(req)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('allows all /api/worker/* sub-paths — not just /generate', async () => {
    const paths = ['/api/worker/', '/api/worker/status', '/api/worker/process/abc']
    for (const path of paths) {
      const req = new NextRequest(`http://localhost${path}`)
      const res = await middleware(req)
      expect(res.headers.get('x-middleware-next')).toBe('1')
    }
  })

  it('does NOT treat /api/worker-something as a worker path (prefix must be /api/worker/)', async () => {
    // /api/worker-something is NOT under /api/worker/ — should be gated
    const req = new NextRequest('http://localhost/api/worker-something')
    const res = await middleware(req)
    // No valid cookie → should be blocked (401 for API routes)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Unauthenticated access — no cookie present
// ---------------------------------------------------------------------------

describe('middleware — unauthenticated requests', () => {
  let middleware: MiddlewareFn

  beforeEach(async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    middleware = await importMiddleware()
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('returns 401 JSON for unauthenticated API route requests', async () => {
    const req = new NextRequest('http://localhost/api/products')
    const res = await middleware(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 200 HTML login page for unauthenticated page requests', async () => {
    const req = new NextRequest('http://localhost/dashboard')
    const res = await middleware(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toContain('/api/login')
  })

  it('preserves the intended destination in the login form as a hidden redirect field', async () => {
    const req = new NextRequest('http://localhost/products/123/gallery')
    const res = await middleware(req)
    const html = await res.text()
    expect(html).toContain('name="redirect"')
    expect(html).toContain('/products/123/gallery')
  })

  it('shows error message on login page when ?error query param is present', async () => {
    const req = new NextRequest('http://localhost/dashboard?error=1')
    const res = await middleware(req)
    const html = await res.text()
    expect(html).toContain('Incorrect password')
  })

  it('does NOT show error message on login page when ?error is absent', async () => {
    const req = new NextRequest('http://localhost/dashboard')
    const res = await middleware(req)
    const html = await res.text()
    expect(html).not.toContain('Incorrect password')
  })
})

// ---------------------------------------------------------------------------
// XSS prevention — redirect path escaping
// ---------------------------------------------------------------------------

describe('middleware — login page XSS escaping', () => {
  let middleware: MiddlewareFn

  beforeEach(async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    middleware = await importMiddleware()
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('escapes & in the redirect path — a literal & in a URL path stays unencoded and must become &amp; in HTML', async () => {
    // The WHATWG URL parser does NOT percent-encode & in the path component (only in
    // the query string), so a path like /dashboard&foo=bar reaches the middleware as-is.
    // escapeAttr() must convert it to &amp; so the HTML attribute value is well-formed
    // and cannot be used to inject new attributes via HTML entity tricks.
    const req = new NextRequest('http://localhost/dashboard&foo=bar')
    const res = await middleware(req)
    const html = await res.text()
    // The value attribute must contain the entity form, not a bare &
    expect(html).toContain('&amp;')
    // A raw & followed by a non-entity character must not appear inside the attribute value
    expect(html).not.toMatch(/value="[^"]*&(?!amp;|quot;|lt;|gt;)/)
  })

  it('percent-encoded < and > in the URL path are passed through safely without literal tag chars', async () => {
    // The URL parser percent-encodes < and > when passed as literal characters,
    // so nextUrl.pathname contains %3C/%3E — which are already safe in HTML attributes.
    // This test verifies no literal < tag characters appear in the redirect value.
    const req = new NextRequest('http://localhost/path%3Cscript%3Ealert(1)%3C%2Fscript%3E')
    const res = await middleware(req)
    const html = await res.text()
    // The redirect value field must not contain a literal < that could open a tag
    const match = html.match(/name="redirect" value="([^"]*)"/)
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain('<')
  })

  it('percent-encoded " in the URL path does not produce an unescaped quote in the attribute value', async () => {
    // The URL parser encodes literal " to %22, so nextUrl.pathname contains %22,
    // which is safe. This confirms the entire pipeline produces no attribute-breaking quotes.
    const req = new NextRequest('http://localhost/path%22inject%22')
    const res = await middleware(req)
    const html = await res.text()
    const match = html.match(/name="redirect" value="([^"]*)"/)
    expect(match).not.toBeNull()
    // The extracted value should not contain an unescaped double-quote
    expect(match![1]).not.toContain('"')
  })
})

// ---------------------------------------------------------------------------
// Authenticated requests — valid cookie passes through
// ---------------------------------------------------------------------------

describe('middleware — authenticated requests', () => {
  let middleware: MiddlewareFn
  let validToken: string

  beforeEach(async () => {
    vi.resetModules()
    process.env.SITE_PASSWORD = TEST_PASSWORD
    // Compute the expected token BEFORE importing middleware so the cached value
    // inside the module matches what we put in the cookie.
    validToken = await deriveAuthToken(TEST_PASSWORD)
    middleware = await importMiddleware()
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('passes authenticated requests through without redirecting', async () => {
    const req = new NextRequest('http://localhost/dashboard', {
      headers: { Cookie: `site-auth=${validToken}` },
    })
    const res = await middleware(req)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('passes authenticated API requests through (no 401)', async () => {
    const req = new NextRequest('http://localhost/api/products', {
      headers: { Cookie: `site-auth=${validToken}` },
    })
    const res = await middleware(req)
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.status).not.toBe(401)
  })

  it('rejects a cookie with a wrong token value even if the name is correct', async () => {
    const req = new NextRequest('http://localhost/dashboard', {
      headers: { Cookie: 'site-auth=not-a-valid-hmac-token' },
    })
    const res = await middleware(req)
    // Wrong token → show login page
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('rejects a cookie that uses the right algorithm on a different password', async () => {
    const forgeryToken = await deriveAuthToken('wrong-password')
    const req = new NextRequest('http://localhost/dashboard', {
      headers: { Cookie: `site-auth=${forgeryToken}` },
    })
    const res = await middleware(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })
})

// ---------------------------------------------------------------------------
// SITE_PASSWORD not configured — fail-closed
// ---------------------------------------------------------------------------

describe('middleware — SITE_PASSWORD not configured', () => {
  let middleware: MiddlewareFn

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.SITE_PASSWORD
    middleware = await importMiddleware()
  })

  afterEach(() => {
    delete process.env.SITE_PASSWORD
  })

  it('blocks all page requests with login page when SITE_PASSWORD is not set', async () => {
    const req = new NextRequest('http://localhost/dashboard')
    const res = await middleware(req)
    // No SITE_PASSWORD → isAuthenticated() returns false → show login page
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('blocks all API requests with 401 when SITE_PASSWORD is not set', async () => {
    const req = new NextRequest('http://localhost/api/products')
    const res = await middleware(req)
    expect(res.status).toBe(401)
  })
})
