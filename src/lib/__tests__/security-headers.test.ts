import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'
import { applySecurityHeaders, SECURITY_HEADERS } from '@/lib/security-headers'

const REQUIRED_HEADERS = new Map([
  ['strict-transport-security', 'max-age=63072000; includeSubDomains; preload'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
])

describe('security headers', () => {
  it('defines the required HTTP hardening headers without duplicate names', () => {
    const headersByName = new Map(SECURITY_HEADERS.map((header) => [header.key.toLowerCase(), header.value]))

    expect(headersByName.size).toBe(SECURITY_HEADERS.length)
    for (const [key, value] of REQUIRED_HEADERS) {
      expect(headersByName.get(key)).toBe(value)
    }
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
