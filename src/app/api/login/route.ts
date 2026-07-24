import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'
import { secretsEqual } from '@/lib/server-secrets'
import { loginClientKey, loginRateLimiter } from '@/lib/login-rate-limit'
import { logger } from '@/lib/server-logger'

// Hard cap on input sizes accepted by the login endpoint.
// A legitimate password will never approach these limits; rejecting early
// prevents DoS via expensive HMAC computation on oversized payloads.
const MAX_PASSWORD_BYTES = 1024   // ~1 KiB — far above any real password
const MAX_REDIRECT_LENGTH = 2048  // characters, not bytes

// Session lifetime for the auth cookie. Made configurable so a deployment can
// enforce its own session policy (shorter for security-sensitive tenants,
// longer for convenience) without a code change; clamped to a sane range and
// defaulting to the historical 7 days when unset or invalid.
const DEFAULT_SESSION_TTL_DAYS = 7
const MIN_SESSION_TTL_DAYS = 1
const MAX_SESSION_TTL_DAYS = 365

function sessionMaxAgeSeconds(): number {
  const raw = Number(process.env.SITE_AUTH_TTL_DAYS)
  const days = Number.isFinite(raw) && raw >= MIN_SESSION_TTL_DAYS
    ? Math.min(Math.floor(raw), MAX_SESSION_TTL_DAYS)
    : DEFAULT_SESSION_TTL_DAYS
  return days * 24 * 60 * 60
}

/** Auth responses must never be cached by a shared proxy — they carry per-user
 *  state (Set-Cookie, error flags). Apply no-store uniformly. */
function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

/**
 * Terminal error page for the login form POST (throttled, misconfigured,
 * malformed request). These responses answer a browser form submission — a
 * body-less status renders as a completely blank page with no way forward, so
 * each terminal path gets a short explanation and a link back to the sign-in
 * gate. Status codes and headers are unchanged; only the body is added.
 * Styling mirrors the login gate served by middleware.ts.
 */
function errorPage(
  status: number,
  heading: string,
  message: string,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${heading} - Aloa AI Product Imager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 0 1rem; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; text-align: center; }
    h1 { font-size: 1.25rem; margin-bottom: 0.75rem; }
    p { font-size: 0.875rem; color: #a1a1aa; margin-bottom: 1.25rem; }
    a { display: inline-block; color: #f4f4f5; background: #2563eb; text-decoration: none; border-radius: 8px; padding: 0.625rem 1.25rem; font-size: 0.875rem; font-weight: 500; }
    a:hover { background: #3b82f6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    <a href="/">Back to sign in</a>
  </div>
</body>
</html>`
  return noStore(new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
  }))
}

// Cached derivation Promise — mirrors the pattern in middleware.ts.
// SITE_PASSWORD is immutable per isolate, so the derived cookie value never
// changes. Computing it once at module load means successful logins get a
// cache hit instead of paying the async Web Crypto cost on every request.
let _cachedTokenPromise: Promise<string> | null = null

function getCachedToken(password: string): Promise<string> {
  if (_cachedTokenPromise === null) {
    const pending = deriveAuthToken(password)
    // A rejected derivation must not be cached for the isolate's lifetime —
    // otherwise a transient Web Crypto fault at warm-up would make every
    // subsequent correct-password login fail until the isolate restarts.
    // Clear the slot so the next login retries; the current caller still sees
    // the rejection. Attaching the handler here also keeps the module-load
    // warm-up call below from surfacing as an unhandled promise rejection.
    pending.catch(() => {
      if (_cachedTokenPromise === pending) _cachedTokenPromise = null
    })
    _cachedTokenPromise = pending
  }
  return _cachedTokenPromise
}

if (process.env.SITE_PASSWORD) {
  void getCachedToken(process.env.SITE_PASSWORD)
}

/**
 * Validate the user-supplied redirect path, returning '/' for anything unsafe.
 *
 * A prefix check alone (`startsWith('/') && !startsWith('//')`) is NOT enough:
 * the WHATWG URL parser treats backslashes as slashes and strips tab/newline
 * characters in http(s) URLs, so values like "/\evil.com" or "/\t/evil.com"
 * pass the prefix check yet resolve to a foreign origin — an open redirect.
 * Defend by resolving the candidate against the request URL and verifying the
 * origin is unchanged, then re-emit the normalized pathname + search.
 */
function sanitizeRedirectPath(rawRedirect: string, requestUrl: string): string {
  const trimmed = rawRedirect.slice(0, MAX_REDIRECT_LENGTH)
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/'
  try {
    const resolved = new URL(trimmed, requestUrl)
    if (resolved.origin !== new URL(requestUrl).origin) return '/'
    return resolved.pathname + resolved.search
  } catch {
    return '/'
  }
}

/**
 * Direct browser navigation to /api/login (bookmark, typed URL, back/forward
 * history) previously got a bare 405 — the form only ever POSTs here. Redirect
 * to the app root instead: authenticated users land on the app, everyone else
 * gets the login gate rendered by the middleware.
 */
export function GET(request: NextRequest) {
  return noStore(NextResponse.redirect(new URL('/', request.url), 303))
}

export async function POST(request: NextRequest) {
  // Fail closed: if SITE_PASSWORD is not configured, deny all logins rather
  // than falling back to a well-known hardcoded credential.
  const PASSWORD = process.env.SITE_PASSWORD
  if (!PASSWORD) {
    logger.error('[Login] SITE_PASSWORD is not set — all logins denied')
    return errorPage(503, 'Sign-in unavailable', 'The service cannot authenticate right now. Please try again later.')
  }

  // Brute-force throttle: once a client exceeds the failed-attempt cap, reject
  // with 429 + Retry-After before doing any further work. Checked up front so a
  // throttled attacker can't keep paying for form parsing or HMAC comparison.
  const clientKey = loginClientKey(request.headers)
  const limit = loginRateLimiter.check(clientKey)
  if (limit.limited) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))
    return errorPage(
      429,
      'Too many attempts',
      `Too many failed sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { 'Retry-After': String(limit.retryAfterSeconds) }
    )
  }

  // Malformed Content-Type or body (e.g. application/json sent to a form
  // endpoint) causes formData() to throw. Catch it and return 400 rather than
  // letting Next.js surface an opaque 500 for a client-side mistake.
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return errorPage(400, 'Invalid request', 'The sign-in request could not be read. Go back and try again.')
  }
  // formData.get() returns string | File | null — guard against File objects
  // (e.g. multipart abuse) before passing to safeCompare.
  const rawPassword = formData.get('password')
  const password = typeof rawPassword === 'string' ? rawPassword : ''
  const rawRedirect = formData.get('redirect')
  const redirectPath = typeof rawRedirect === 'string' ? rawRedirect : '/'

  // Reject oversized passwords before doing any crypto work.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return errorPage(400, 'Invalid request', 'The sign-in request could not be read. Go back and try again.')
  }

  const safeRedirect = sanitizeRedirectPath(redirectPath, request.url)

  if (secretsEqual(password, PASSWORD)) {
    // Successful auth clears the client's failed-attempt counter so a user who
    // mistyped a few times before getting it right starts fresh.
    loginRateLimiter.reset(clientKey)
    // Deriving the cookie token uses Web Crypto and can fail (transiently) even
    // though the password was correct. Return 503 — the same "service not able
    // to authenticate right now" signal as the missing-SITE_PASSWORD path —
    // instead of letting the rejection escape as an opaque 500.
    let cookieToken: string
    try {
      cookieToken = await getCachedToken(PASSWORD)
    } catch (err) {
      logger.error('[Login] Failed to derive auth cookie token', err instanceof Error ? err.message : String(err))
      return errorPage(503, 'Sign-in unavailable', 'The service cannot authenticate right now. Please try again later.')
    }
    const response = NextResponse.redirect(new URL(safeRedirect, request.url), 303)
    response.cookies.set(AUTH_COOKIE_NAME, cookieToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: sessionMaxAgeSeconds(),
      path: '/', // Site-password auth gates the whole app, so the cookie must cover every route.
    })
    return noStore(response)
  }

  // Count this failure toward the brute-force ceiling.
  loginRateLimiter.recordFailure(clientKey)

  // Slow brute-force attempts with a fixed artificial delay before responding.
  // This doesn't require shared state and doesn't reveal whether the password
  // was close — it just makes rapid successive attempts meaningfully slower.
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  // Wrong password — redirect back to the same page to show login with error
  const errorUrl = new URL(safeRedirect, request.url)
  errorUrl.searchParams.set('error', '1')
  return noStore(new NextResponse(null, {
    status: 303,
    headers: { Location: errorUrl.pathname + errorUrl.search },
  }))
}
