import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'
import { applySecurityHeaders, SECURITY_HEADERS } from '@/lib/security-headers'

const REQUIRED_HEADERS = new Map([
  ['strict-transport-security', 'max-age=63072000; includeSubDomains; preload'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), interest-cohort=()'],
  ['x-dns-prefetch-control', 'off'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['x-permitted-cross-domain-policies', 'none'],
  // Spectre mitigation — blocks other origins from reading this app's responses.
  // Pinned here so it can't be silently dropped from SECURITY_HEADERS: the loop
  // below only checks headers that are *applied*, so an omission from the source
  // list would otherwise pass every existing assertion unnoticed.
  ['cross-origin-resource-policy', 'same-origin'],
])

describe('security headers', () => {
  it('defines the required HTTP hardening headers without duplicate names', () => {
    const headersByName = new Map(SECURITY_HEADERS.map((header) => [header.key.toLowerCase(), header.value]))

    expect(headersByName.size).toBe(SECURITY_HEADERS.length)
    for (const [key, value] of REQUIRED_HEADERS) {
      expect(headersByName.get(key)).toBe(value)
    }
  })

  it('pins every header in the mechanical set — a new header must be added to REQUIRED_HEADERS', () => {
    // Guard against the coverage gap that let Cross-Origin-Resource-Policy ship
    // unpinned: any future addition to SECURITY_HEADERS (except the deliberately
    // deferred CSP) must also be given an exact-value assertion in REQUIRED_HEADERS,
    // so a hardening header can never be weakened or removed without a test failing.
    const pinned = new Set(REQUIRED_HEADERS.keys())
    const unpinned = SECURITY_HEADERS
      .map((header) => header.key.toLowerCase())
      .filter((key) => key !== 'content-security-policy' && !pinned.has(key))
    expect(unpinned).toEqual([])
  })

  it('keeps CSP out of the mechanical header set pending policy review', () => {
    expect(SECURITY_HEADERS.some((header) => header.key.toLowerCase() === 'content-security-policy')).toBe(false)
  })

  it('applies the same reusable headers to direct middleware responses', () => {
    const headers = new Headers()
    applySecurityHeaders(headers)

    for (const { key, value } of SECURITY_HEADERS) {
      expect(headers.get(key)).toBe(value)
    }
  })

  it('configures Next.js to send security headers on every route and strip X-Powered-By', async () => {
    expect(nextConfig.poweredByHeader).toBe(false)

    const headersConfig = await nextConfig.headers?.()
    expect(headersConfig).toEqual([
      {
        source: '/(.*)',
        headers: Array.from(SECURITY_HEADERS),
      },
    ])
  })
})
