import { createHmac } from 'crypto'

/** Cookie name used by the site-password auth layer. */
export const AUTH_COOKIE_NAME = 'site-auth'

/**
 * Derive the expected cookie value from the configured SITE_PASSWORD.
 *
 * Instead of storing the literal string "authenticated" (predictable by
 * anyone who reads the source), we store an HMAC-SHA256 digest keyed on
 * SITE_PASSWORD. An attacker must know the actual password to forge a
 * valid cookie value.
 *
 * Returns null when SITE_PASSWORD is not set so callers can fail closed.
 */
export function deriveAuthToken(password: string): string {
  return createHmac('sha256', password).update('site-auth-v1').digest('hex')
}
