import type { NextRequest } from 'next/server'

/**
 * Cookie name used by the site-password auth layer.
 *
 * The `__Host-` prefix makes the browser itself refuse the cookie unless it is
 * set with Secure, Path=/, and no Domain attribute — so a regression that
 * weakens those attributes fails loudly at the browser instead of silently
 * shipping, and a sibling subdomain (relevant when deployed under a custom
 * apex like aloa.agency) can never plant/override this cookie via a
 * Domain-scoped copy (cookie tossing / session fixation).
 *
 * Renaming this constant invalidates all live sessions (users re-enter the
 * site password once); keep the prefix if the base name ever changes.
 */
export const AUTH_COOKIE_NAME = '__Host-site-auth'

/**
 * XOR-based timing-resistant string comparison.
 *
 * JavaScript's `===` exits on the first differing character, leaking
 * information about how "close" two strings are via timing. This function
 * always iterates over every character of `expected`, so execution time
 * is independent of where a mismatch occurs.
 *
 * Not a cryptographic primitive — for that, use Node's `timingSafeEqual`
 * (see server-secrets.ts). However, this implementation works in both Node.js
 * and the Edge Runtime (no `crypto` import required) and eliminates the most
 * obvious timing side-channel.
 */
export function timingResistantEqual(provided: string, expected: string): boolean {
  const n = expected.length
  const pLen = provided.length
  // Accumulate length mismatch into diff so we never return early based on length.
  let diff = pLen !== n ? 1 : 0
  for (let i = 0; i < n; i++) {
    // Use 0 for out-of-bounds indices in `provided` instead of the modulo-wrap
    // trick, which relied on silent NaN→0 coercion when provided is empty.
    diff |= (i < pLen ? provided.charCodeAt(i) : 0) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Returns true when the request carries the correct ADMIN_SECRET header.
 *
 * Edge Runtime-compatible version using XOR-based timing-resistant comparison.
 * Node.js API routes must use `isAdminAuthorizedNode` from server-secrets.ts
 * instead, which uses `crypto.timingSafeEqual` for a stronger guarantee.
 * This function is intentionally kept Edge Runtime-safe for future middleware use.
 *
 * Fails closed: if ADMIN_SECRET is not configured, all requests are denied.
 * During rotation, ADMIN_SECRET_PREVIOUS is also accepted — mirrors
 * `isAdminAuthorizedNode` / the rotation procedure in server-secrets.ts.
 */
export function isAdminAuthorized(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return false
  const provided = request.headers.get('x-admin-secret') ?? ''
  if (provided.length === 0) return false
  if (timingResistantEqual(provided, adminSecret)) return true
  const previousSecret = process.env.ADMIN_SECRET_PREVIOUS
  return Boolean(previousSecret) && timingResistantEqual(provided, previousSecret as string)
}

/**
 * Derive the expected cookie value from the configured SITE_PASSWORD.
 *
 * Instead of storing the literal string "authenticated" (predictable by
 * anyone who reads the source), we store an HMAC-SHA256 digest keyed on
 * SITE_PASSWORD. An attacker must know the actual password to forge a
 * valid cookie value.
 *
 * Uses the Web Crypto API (crypto.subtle) so this module works in both
 * Node.js and the Edge Runtime (Next.js middleware runs on Edge).
 *
 * Returns the hex-encoded HMAC digest.
 */
export async function deriveAuthToken(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('site-auth-v1'))
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')
}
