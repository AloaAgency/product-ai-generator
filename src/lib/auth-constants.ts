import type { NextRequest } from 'next/server'

/** Cookie name used by the site-password auth layer. */
export const AUTH_COOKIE_NAME = 'site-auth'

/**
 * XOR-based timing-resistant string comparison.
 *
 * JavaScript's `===` exits on the first differing character, leaking
 * information about how "close" two strings are via timing. This function
 * always iterates over every character of `expected`, so execution time
 * is independent of where a mismatch occurs.
 *
 * Not a cryptographic primitive — for that, use Node's `timingSafeEqual`
 * (see login/route.ts). However, this implementation works in both Node.js
 * and the Edge Runtime (no `crypto` import required) and eliminates the most
 * obvious timing side-channel.
 */
export function timingResistantEqual(provided: string, expected: string): boolean {
  const n = expected.length
  // Accumulate length mismatch into diff so we never return early based on length.
  let diff = provided.length !== n ? 1 : 0
  for (let i = 0; i < n; i++) {
    // For shorter `provided`, wrap index so charCodeAt never returns NaN.
    diff |= provided.charCodeAt(i % (provided.length || 1)) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Returns true when the request carries the correct ADMIN_SECRET header.
 * Used by internal admin endpoints that are already behind site-password auth.
 * Fails closed: if ADMIN_SECRET is not configured, all requests are denied.
 */
export function isAdminAuthorized(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return false
  const provided = request.headers.get('x-admin-secret') ?? ''
  if (provided.length === 0) return false
  return timingResistantEqual(provided, adminSecret)
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
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
