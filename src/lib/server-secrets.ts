import { timingSafeEqual } from 'crypto'

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
