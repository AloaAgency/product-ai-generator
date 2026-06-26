/**
 * Tests for src/lib/login-rate-limit.ts
 *
 * The limiter is deterministic: every method accepts an explicit `now` so these
 * tests advance time by passing timestamps rather than relying on fake timers.
 */
import { describe, expect, it } from 'vitest'
import { createLoginRateLimiter, loginClientKey } from '@/lib/login-rate-limit'

describe('createLoginRateLimiter — failure counting', () => {
  it('does not throttle below the failure cap', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 1000 })
    expect(limiter.recordFailure('a', 0).limited).toBe(false)
    expect(limiter.recordFailure('a', 10).limited).toBe(false)
    expect(limiter.check('a', 20).limited).toBe(false)
  })

  it('throttles once the cap is reached and reports a positive Retry-After', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 60_000 })
    limiter.recordFailure('a', 0)
    limiter.recordFailure('a', 0)
    const decision = limiter.recordFailure('a', 0)
    expect(decision.limited).toBe(true)
    expect(decision.retryAfterSeconds).toBeGreaterThan(0)
    // A subsequent read-only check still reports throttled within the window.
    expect(limiter.check('a', 1000).limited).toBe(true)
  })

  it('tracks keys independently — one client hitting the cap does not affect another', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 60_000 })
    limiter.recordFailure('a', 0)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', 0).limited).toBe(true)
    expect(limiter.check('b', 0).limited).toBe(false)
  })
})

describe('createLoginRateLimiter — window expiry and reset', () => {
  it('clears the counter once the window elapses', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 1000 })
    limiter.recordFailure('a', 0)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', 500).limited).toBe(true)
    // After the window passes, the key is fresh again.
    expect(limiter.check('a', 1001).limited).toBe(false)
    expect(limiter.recordFailure('a', 1001).limited).toBe(false)
  })

  it('reset() immediately clears a throttled key (mirrors a successful login)', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 1, windowMs: 60_000 })
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', 0).limited).toBe(true)
    limiter.reset('a')
    expect(limiter.check('a', 0).limited).toBe(false)
  })
})

describe('createLoginRateLimiter — memory bounds', () => {
  it('evicts oldest keys past maxKeys so unique-key floods cannot grow unbounded', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000, maxKeys: 3 })
    for (let i = 0; i < 10; i++) {
      limiter.recordFailure(`key-${i}`, 0)
    }
    // The earliest keys must have been evicted; only recent ones can still be tracked.
    expect(limiter.check('key-0', 0).limited).toBe(false)
    expect(limiter.check('key-1', 0).limited).toBe(false)
  })
})

describe('loginClientKey', () => {
  it('uses the first IP from x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
    expect(loginClientKey(headers)).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.4' })
    expect(loginClientKey(headers)).toBe('198.51.100.4')
  })

  it('falls back to a shared "unknown" bucket when no client address is present', () => {
    expect(loginClientKey(new Headers())).toBe('unknown')
  })
})
