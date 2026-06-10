import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'
import { secretsEqual } from '@/lib/server-secrets'
import { logger } from '@/lib/logger'

// Hard cap on input sizes accepted by the login endpoint.
// A legitimate password will never approach these limits; rejecting early
// prevents DoS via expensive HMAC computation on oversized payloads.
const MAX_PASSWORD_BYTES = 1024   // ~1 KiB — far above any real password
const MAX_REDIRECT_LENGTH = 2048  // characters, not bytes

// Cached derivation Promise — mirrors the pattern in middleware.ts.
// SITE_PASSWORD is immutable per isolate, so the derived cookie value never
// changes. Computing it once at module load means successful logins get a
// cache hit instead of paying the async Web Crypto cost on every request.
let _cachedTokenPromise: Promise<string> | null = null

function getCachedToken(password: string): Promise<string> {
  if (_cachedTokenPromise === null) {
    _cachedTokenPromise = deriveAuthToken(password)
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

export async function POST(request: NextRequest) {
  // Fail closed: if SITE_PASSWORD is not configured, deny all logins rather
  // than falling back to a well-known hardcoded credential.
  const PASSWORD = process.env.SITE_PASSWORD
  if (!PASSWORD) {
    logger.error('[Login] SITE_PASSWORD is not set — all logins denied')
    return new NextResponse(null, { status: 503 })
  }

  // Malformed Content-Type or body (e.g. application/json sent to a form
  // endpoint) causes formData() to throw. Catch it and return 400 rather than
  // letting Next.js surface an opaque 500 for a client-side mistake.
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  // formData.get() returns string | File | null — guard against File objects
  // (e.g. multipart abuse) before passing to safeCompare.
  const rawPassword = formData.get('password')
  const password = typeof rawPassword === 'string' ? rawPassword : ''
  const rawRedirect = formData.get('redirect')
  const redirectPath = typeof rawRedirect === 'string' ? rawRedirect : '/'

  // Reject oversized passwords before doing any crypto work.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return new NextResponse(null, { status: 400 })
  }

  const safeRedirect = sanitizeRedirectPath(redirectPath, request.url)

  if (secretsEqual(password, PASSWORD)) {
    const response = NextResponse.redirect(new URL(safeRedirect, request.url), 303)
    response.cookies.set(AUTH_COOKIE_NAME, await getCachedToken(PASSWORD), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/', // Site-password auth gates the whole app, so the cookie must cover every route.
    })
    return response
  }

  // Slow brute-force attempts with a fixed artificial delay before responding.
  // This doesn't require shared state and doesn't reveal whether the password
  // was close — it just makes rapid successive attempts meaningfully slower.
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  // Wrong password — redirect back to the same page to show login with error
  const errorUrl = new URL(safeRedirect, request.url)
  errorUrl.searchParams.set('error', '1')
  return new NextResponse(null, {
    status: 303,
    headers: { Location: errorUrl.pathname + errorUrl.search },
  })
}
