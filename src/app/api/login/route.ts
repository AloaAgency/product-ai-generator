import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'

/** Compare two strings in constant time to mitigate timing attacks. */
function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) {
      // Still run the comparison on equally-sized buffers so execution time
      // doesn't reveal which side is shorter.
      timingSafeEqual(bufA, bufA)
      return false
    }
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

// Hard cap on input sizes accepted by the login endpoint.
// A legitimate password will never approach these limits; rejecting early
// prevents DoS via expensive HMAC computation on oversized payloads.
const MAX_PASSWORD_BYTES = 1024   // ~1 KiB — far above any real password
const MAX_REDIRECT_LENGTH = 2048  // characters, not bytes

export async function POST(request: NextRequest) {
  // Fail closed: if SITE_PASSWORD is not configured, deny all logins rather
  // than falling back to a well-known hardcoded credential.
  const PASSWORD = process.env.SITE_PASSWORD
  if (!PASSWORD) {
    console.error('[Login] SITE_PASSWORD is not set — all logins denied')
    return new NextResponse(null, { status: 503 })
  }

  const formData = await request.formData()
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

  // Validate redirect path: must be a simple relative path starting with /
  // and NOT a protocol-relative URL (//host) to prevent open-redirect attacks.
  // Also cap length to avoid storing/reflecting arbitrarily long strings.
  const trimmedRedirect = redirectPath.slice(0, MAX_REDIRECT_LENGTH)
  const safeRedirect =
    trimmedRedirect.startsWith('/') && !trimmedRedirect.startsWith('//')
      ? trimmedRedirect
      : '/'

  if (safeCompare(password, PASSWORD)) {
    const response = NextResponse.redirect(new URL(safeRedirect, request.url), 303)
    response.cookies.set(AUTH_COOKIE_NAME, await deriveAuthToken(PASSWORD), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
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
