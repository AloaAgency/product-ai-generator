import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

/**
 * Secret rotation procedure (CRON_SECRET, ADMIN_SECRET, or any env-var secret):
 *
 * Zero-downtime rotation is supported via an overlap window:
 *   1. Generate a new secret value.
 *   2. Set `CRON_SECRET_PREVIOUS` / `ADMIN_SECRET_PREVIOUS` to the CURRENT value and
 *      `CRON_SECRET` / `ADMIN_SECRET` to the new value, then deploy. Callers still
 *      sending the old value keep working (matchesRotatableSecret accepts either).
 *   3. Update every caller (Vercel cron config, admin tooling) to send the new value.
 *   4. Remove the `*_PREVIOUS` env var and deploy again to close the overlap window.
 *
 * The `*_PREVIOUS` var must never be set outside an active rotation — leaving it
 * around indefinitely keeps a retired credential valid.
 */

/**
 * Compare two strings in constant time to mitigate timing attacks.
 *
 * Uses Node's `timingSafeEqual` so comparison time is independent of where a
 * mismatch occurs. When lengths differ, a dummy same-length comparison runs
 * so the branch timing does not reveal whether lengths matched.
 *
 * Node.js-only — do not import this module from Edge Runtime code (middleware).
 * Edge Runtime callers should use `timingResistantEqual` in auth-constants.ts.
 */
export function secretsEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) {
      timingSafeEqual(bufA, bufA)
      return false
    }
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

/**
 * Compare a client-supplied secret against the active secret and, during a
 * rotation overlap window, the previous one (see the rotation procedure above).
 *
 * Fails closed: an unset/empty current secret or an empty provided value is
 * always rejected — a `*_PREVIOUS` value alone never grants access, so a
 * deployment that lost its primary secret cannot silently run on the retired
 * one. Both comparisons use `secretsEqual` (constant-time).
 */
export function matchesRotatableSecret(
  provided: string,
  currentSecret: string | undefined,
  previousSecret?: string
): boolean {
  if (!currentSecret || provided.length === 0) return false
  if (secretsEqual(provided, currentSecret)) return true
  return Boolean(previousSecret) && secretsEqual(provided, previousSecret as string)
}

/**
 * Returns true when the request carries the correct ADMIN_SECRET header.
 *
 * Node.js-only counterpart to `isAdminAuthorized` in auth-constants.ts.
 * Uses `crypto.timingSafeEqual` (hardware-level constant time) instead of
 * the XOR-based fallback used in Edge Runtime contexts.
 * Node.js API routes must import this function; Edge Runtime / middleware code
 * should use `isAdminAuthorized` from auth-constants.ts.
 *
 * Fails closed: if ADMIN_SECRET is not configured, all requests are denied.
 * During rotation, ADMIN_SECRET_PREVIOUS is also accepted (see rotation
 * procedure at the top of this file).
 */
export function isAdminAuthorizedNode(request: NextRequest): boolean {
  const provided = request.headers.get('x-admin-secret') ?? ''
  return matchesRotatableSecret(provided, process.env.ADMIN_SECRET, process.env.ADMIN_SECRET_PREVIOUS)
}
