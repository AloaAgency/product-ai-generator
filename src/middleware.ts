import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken, timingResistantEqual } from '@/lib/auth-constants'

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
    input:focus { border-color: #71717a; box-shadow: 0 0 0 2px rgba(113, 113, 122, 0.2); }
    button { width: 100%; margin-top: 1rem; padding: 0.75rem; border-radius: 8px; border: none; background: #fff; color: #09090b; font-size: 1rem; font-weight: 500; cursor: pointer; min-height: 2.75rem; }
    button:hover { background: #e4e4e7; }
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

// Cached expected auth token, computed once per isolate lifetime.
// SITE_PASSWORD is configured at deploy time and never changes while the
// process is running, so the derived HMAC token is constant.
let _cachedExpectedToken: string | null = null

async function getExpectedToken(password: string): Promise<string> {
  if (_cachedExpectedToken === null) {
    _cachedExpectedToken = await deriveAuthToken(password)
  }
  return _cachedExpectedToken
}

/** Returns true when the request carries a valid site-auth cookie. */
async function isAuthenticated(request: NextRequest): Promise<boolean> {
  try {
    const password = process.env.SITE_PASSWORD
    if (!password) return false
    const auth = request.cookies.get(AUTH_COOKIE_NAME)
    // Cookie value is an HMAC derived from SITE_PASSWORD — a predictable static
    // string like "authenticated" would allow anyone who reads the source to
    // forge a valid cookie.
    if (!auth?.value) return false
    return timingResistantEqual(auth.value, await getExpectedToken(password))
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

// Security headers applied to every response generated directly by middleware.
// Responses that pass through to Next.js pages/API routes receive these via
// next.config.ts headers(); direct middleware responses bypass that pipeline.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value)
  }
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

    // Show login page, preserving the intended destination. Return 200 so the
    // browser renders the gate as a normal document instead of a failed request.
    // cache-control: no-store prevents CDNs or proxies from caching the login
    // gate and serving it to users who subsequently authenticate.
    const showError = request.nextUrl.searchParams.has('error')
    return withSecurityHeaders(
      new NextResponse(loginPage(showError, pathname), {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'cache-control': 'no-store',
        },
      })
    )
  } catch (err) {
    // Last-resort handler: if an unexpected error escapes (e.g. a Node/Edge
    // runtime fault unrelated to auth), return a structured error response
    // instead of letting the middleware throw an unhandled exception, which
    // would surface as an opaque 500 with no useful headers.
    console.error('[Middleware] Unexpected error', err)
    if (pathname.startsWith('/api/')) {
      return new NextResponse(
        JSON.stringify({ error: 'Service unavailable' }),
        { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
      )
    }
    return new NextResponse('Service unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    })
  }
}

export const config = {
  // Exclude static assets, images, and known public files from middleware
  // to avoid cookie-check overhead on requests that never need auth.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map)$).*)'],
}
