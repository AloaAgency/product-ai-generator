import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken, timingResistantEqual } from '@/lib/auth-constants'
import { applySecurityHeaders } from '@/lib/security-headers'
import { logger } from '@/lib/logger'

// Static parts of the login page HTML, split so the form (which varies per request)
// can be inserted between them without re-declaring the surrounding boilerplate.
const LOGIN_PAGE_PREFIX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Login - Aloa AI Product Imager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 0 1rem; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    label { display: block; font-size: 0.875rem; color: #a1a1aa; margin-bottom: 0.375rem; }
    input { width: 100%; padding: 0.75rem; border-radius: 8px; border: 1px solid #3f3f46; background: #27272a; color: #f4f4f5; font-size: 1rem; outline: none; min-height: 2.75rem; }
    input:focus { border-color: #71717a; box-shadow: 0 0 0 1px #71717a; }
    button { width: 100%; margin-top: 1rem; padding: 0.75rem; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-size: 1rem; font-weight: 500; cursor: pointer; min-height: 2.75rem; }
    button:hover { background: #3b82f6; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.75rem; text-align: center; }
    @media (max-width: 420px) { .card { padding: 1.5rem 1.25rem; } }
  </style>
</head>
<body>
  <div class="card">
    <h1>Aloa AI Product Imager</h1>`

// Inline script that disables the submit button and shows "Signing in…"
// during form submission, matching the loading-state pattern used elsewhere
// in the app (e.g. BugReportWidget sets isSubmitting on submit).
const LOGIN_PAGE_SUFFIX = `  </div>
  <script>
    document.querySelector('form').addEventListener('submit', function() {
      var btn = this.querySelector('[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in\u2026'; }
    });
  </script>
</body>
</html>`

const ERROR_HTML = '<p class="error">Incorrect password</p>'

/** Minimal HTML-attribute escaping to prevent reflected XSS via the redirect path. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function loginPage(showError: boolean, redirectPath: string) {
  const safeRedirect = escapeAttr(redirectPath)
  return (
    LOGIN_PAGE_PREFIX +
    `\n    <form method="POST" action="/api/login">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="Enter password" autofocus required />
      <button type="submit">Sign In</button>
      ${showError ? ERROR_HTML : ''}
    </form>\n` +
    LOGIN_PAGE_SUFFIX
  )
}

// Cache SITE_PASSWORD at module load — the value is immutable per isolate in
// production, so reading process.env once avoids a hash-map lookup on every request.
const SITE_PASSWORD = process.env.SITE_PASSWORD ?? null

// Cached derivation Promise, computed once per isolate lifetime.
// Storing the Promise (rather than the resolved string) means concurrent
// requests that arrive before the first derivation completes all share the
// same in-flight Promise instead of each triggering a redundant HMAC call.
let _tokenPromise: Promise<string> | null = null

function getExpectedToken(password: string): Promise<string> {
  if (_tokenPromise === null) {
    const pending = deriveAuthToken(password)
    // A rejected derivation must not be cached for the isolate's lifetime —
    // that would turn a transient Web Crypto fault into a permanent lockout
    // (every request fails closed until the isolate restarts). Clear the slot
    // so the next request retries; the current caller still sees the rejection
    // and fails closed for this request only. Attaching the handler here also
    // keeps the module-load warm-up call below from surfacing as an unhandled
    // promise rejection.
    pending.catch(() => {
      if (_tokenPromise === pending) _tokenPromise = null
    })
    _tokenPromise = pending
  }
  return _tokenPromise
}

// Kick off the derivation at module load so the first real auth check finds an
// already-resolved (or nearly-resolved) Promise rather than paying the async
// Web Crypto cost during a live request.
if (SITE_PASSWORD) {
  void getExpectedToken(SITE_PASSWORD)
}

/** Returns true when the request carries a valid site-auth cookie. */
async function isAuthenticated(request: NextRequest): Promise<boolean> {
  try {
    if (!SITE_PASSWORD) return false
    const auth = request.cookies.get(AUTH_COOKIE_NAME)
    // Cookie value is an HMAC derived from SITE_PASSWORD — a predictable static
    // string like "authenticated" would allow anyone who reads the source to
    // forge a valid cookie.
    if (!auth?.value) return false
    return timingResistantEqual(auth.value, await getExpectedToken(SITE_PASSWORD))
  } catch {
    // Fail closed: if Web Crypto is unavailable or throws, deny access rather
    // than propagating an unhandled rejection through the middleware.
    return false
  }
}

/**
 * Paths that must bypass site-password auth entirely.
 *   /api/login         — unauthenticated users must be able to submit credentials
 *   /api/worker/…      — uses its own CRON_SECRET; site-password doesn't apply
 */
function isPublicPath(pathname: string): boolean {
  return pathname === '/api/login' || pathname.startsWith('/api/worker/')
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  applySecurityHeaders(response.headers)
  return response
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  try {
    if (isPublicPath(pathname)) {
      return withSecurityHeaders(NextResponse.next())
    }

    if (await isAuthenticated(request)) {
      return withSecurityHeaders(NextResponse.next())
    }

    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401, headers: { 'cache-control': 'no-store' } }
        )
      )
    }

    // Show login page, preserving the intended destination (path AND query —
    // the login route validates and forwards both). Return 200 so the browser
    // renders the gate as a normal document instead of a failed request.
    // cache-control: no-store prevents CDNs or proxies from caching the login
    // gate and serving it to users who subsequently authenticate.
    const params = new URLSearchParams(request.nextUrl.search)
    const showError = params.has('error')
    // `error` is internal to the login flow (appended by a failed POST) — strip
    // it so a successful login doesn't carry it into the destination URL.
    params.delete('error')
    const query = params.toString()
    const destination = pathname + (query ? `?${query}` : '')
    return withSecurityHeaders(
      new NextResponse(loginPage(showError, destination), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    )
  } catch (err) {
    // Last-resort handler: if an unexpected error escapes (e.g. a Node/Edge
    // runtime fault unrelated to auth), return a structured error response
    // instead of letting the middleware throw an unhandled exception, which
    // would surface as an opaque 500 with no useful headers.
    logger.error('[Middleware] Unexpected error', err instanceof Error ? err.message : String(err))
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        NextResponse.json(
          { error: 'Service unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      )
    }
    return withSecurityHeaders(
      new NextResponse('Service unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      })
    )
  }
}

export const config = {
  // Exclude static assets, images, and known public files from middleware
  // to avoid cookie-check overhead on requests that never need auth.
  // txt covers robots.txt; xml covers sitemaps; webmanifest covers PWA manifests.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map|txt|xml|webmanifest)$).*)'],
}
