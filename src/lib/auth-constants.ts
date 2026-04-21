import type { NextRequest } from 'next/server'

/** Cookie name used by the site-password auth layer. */
export const AUTH_COOKIE_NAME = 'site-auth'

/**
 * Returns true when the request carries the correct ADMIN_SECRET header.
 * Used by internal admin endpoints that are already behind site-password auth.
 * Fails closed: if ADMIN_SECRET is not configured, all requests are denied.
 */
export function isAdminAuthorized(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return false
  return request.headers.get('x-admin-secret') === adminSecret
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
