export type SecurityHeader = {
  key: string
  value: string
}

export const SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
] as const

export function applySecurityHeaders(headers: Headers) {
  for (const { key, value } of SECURITY_HEADERS) {
    headers.set(key, value)
  }
}
