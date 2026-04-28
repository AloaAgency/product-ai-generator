import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

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
 * Returns true when the request carries the correct ADMIN_SECRET header.
 *
 * Node.js-only counterpart to `isAdminAuthorized` in auth-constants.ts.
 * Uses `crypto.timingSafeEqual` (hardware-level constant time) instead of
 * the XOR-based fallback, which is suitable for Edge Runtime but weaker.
 * Import this in Node.js API routes; import the other in middleware.
 *
 * Fails closed: if ADMIN_SECRET is not configured, all requests are denied.
 */
export function isAdminAuthorizedNode(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return false
  const provided = request.headers.get('x-admin-secret') ?? ''
  if (provided.length === 0) return false
  return secretsEqual(provided, adminSecret)
}
