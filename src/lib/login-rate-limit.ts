/**
 * Best-effort in-memory brute-force throttle for the site-password login.
 *
 * The login endpoint guards a single shared password, so an attacker who can
 * issue unlimited POSTs can grind through a wordlist limited only by the fixed
 * 150 ms artificial delay. That delay slows a single sequential attacker but
 * does nothing against parallel requests. This limiter adds a per-client cap on
 * the number of *failed* attempts within a rolling window and returns HTTP 429
 * once the cap is exceeded, giving the deployment a real (if best-effort)
 * brute-force ceiling.
 *
 * Design constraints:
 *   - Only failures count. A correct password is never throttled, so a
 *     legitimate user who simply mistypes a few times is unaffected and a
 *     successful login immediately clears the client's counter.
 *   - State is per-process and in memory. In a serverless/multi-instance
 *     deployment each instance tracks independently, so this is a mitigation,
 *     not a hard guarantee — but it raises the cost of brute force from "free"
 *     to "needs to spread across instances and respect Retry-After".
 *   - The key map is bounded (LRU-style eviction) so a flood of unique client
 *     keys cannot grow memory without limit.
 *
 * `now` is injectable on every method purely so tests can advance time without
 * fake timers; callers in production omit it and get `Date.now()`.
 */

export type RateLimitDecision = {
  /** True when the caller has exceeded the failure cap and should be rejected. */
  limited: boolean
  /** Seconds until the current window resets — surface as a `Retry-After` header. */
  retryAfterSeconds: number
}

type Bucket = { count: number; resetAt: number }

export type LoginRateLimiterOptions = {
  /** Max failed attempts per key within the window before requests are throttled. */
  maxFailures?: number
  /** Rolling window length in milliseconds. */
  windowMs?: number
  /** Hard cap on tracked keys; oldest entries are evicted past this. */
  maxKeys?: number
}

// Defaults are deliberately generous: a real user will not approach 30 failed
// attempts in 15 minutes, but an automated brute-forcer hits it almost immediately.
const DEFAULT_MAX_FAILURES = 30
const DEFAULT_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_MAX_KEYS = 10_000

export type LoginRateLimiter = {
  /** Read-only check: is this key currently throttled? Does not mutate state. */
  check(key: string, now?: number): RateLimitDecision
  /** Record a failed login attempt for this key, returning the resulting decision. */
  recordFailure(key: string, now?: number): RateLimitDecision
  /** Clear a key's counter (call on successful login). */
  reset(key: string): void
}

/**
 * Create an isolated rate limiter. Each instance owns its own state, which
 * makes the limiter trivially testable — production code uses the shared
 * `loginRateLimiter` singleton below.
 */
export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const maxFailures = clampPositiveInt(options.maxFailures, DEFAULT_MAX_FAILURES)
  const windowMs = clampPositiveInt(options.windowMs, DEFAULT_WINDOW_MS)
  const maxKeys = clampPositiveInt(options.maxKeys, DEFAULT_MAX_KEYS)
  // Map preserves insertion order, so the first key is the oldest — used for
  // O(1) eviction once the tracked-key budget is exhausted.
  const buckets = new Map<string, Bucket>()

  function evictExpiredAndOverflow(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
  }

  function liveBucket(key: string, now: number): Bucket | null {
    const bucket = buckets.get(key)
    if (!bucket) return null
    if (bucket.resetAt <= now) {
      buckets.delete(key)
      return null
    }
    return bucket
  }

  function decisionFor(bucket: Bucket | null, now: number): RateLimitDecision {
    if (bucket && bucket.count >= maxFailures) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
    }
    return { limited: false, retryAfterSeconds: 0 }
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitDecision {
      return decisionFor(liveBucket(key, now), now)
    },

    recordFailure(key: string, now: number = Date.now()): RateLimitDecision {
      let bucket = liveBucket(key, now)
      if (!bucket) {
        bucket = { count: 0, resetAt: now + windowMs }
        buckets.set(key, bucket)
      }
      bucket.count += 1
      evictExpiredAndOverflow(now)
      return decisionFor(bucket, now)
    },

    reset(key: string): void {
      buckets.delete(key)
    },
  }
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * Read limiter tuning from the environment so a deployment can tighten or
 * loosen the brute-force ceiling without a code change. Invalid/unset values
 * fall back to the safe defaults.
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Process-wide singleton used by the login route. Tuning via:
 *   LOGIN_MAX_FAILED_ATTEMPTS — failures per window before 429 (default 30)
 *   LOGIN_RATE_LIMIT_WINDOW_MS — window length in ms (default 900000 = 15 min)
 */
export const loginRateLimiter: LoginRateLimiter = createLoginRateLimiter({
  maxFailures: envInt('LOGIN_MAX_FAILED_ATTEMPTS'),
  windowMs: envInt('LOGIN_RATE_LIMIT_WINDOW_MS'),
})

/**
 * Derive a stable client key from the request's forwarding headers. Falls back
 * to a shared `unknown` bucket when no client address can be determined — that
 * bucket is throttled collectively, which is the safe (fail-closed) choice for
 * unidentifiable clients.
 */
export function loginClientKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  return 'unknown'
}
