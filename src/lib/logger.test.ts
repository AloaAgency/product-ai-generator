import { describe, expect, it } from 'vitest'

import { sanitizeLogArgument } from './logger'

describe('sanitizeLogArgument', () => {
  it('redacts request-shaped objects, nested credentials, and error details', () => {
    const credential = ['sensitive', 'credential', 'value'].join('-')
    const error = new Error(`upstream rejected Bearer ${credential}`) as Error & {
      request?: unknown
    }
    error.request = {
      headers: { authorization: `Bearer ${credential}` },
      body: credential,
    }

    const input = {
      request: error.request,
      headers: { authorization: `Bearer ${credential}` },
      nested: {
        apiKey: credential,
        error,
        safeValue: 'visible',
      },
    }

    const serialized = JSON.stringify(sanitizeLogArgument(input))
    expect(serialized).not.toContain(credential)
    expect(serialized).toContain('[redacted]')
    expect(serialized).toContain('visible')
  })

  it('handles circular objects without throwing or mutating the input', () => {
    const input: { label: string; self?: unknown } = { label: 'safe' }
    input.self = input

    const sanitized = sanitizeLogArgument(input) as { label: string; self: string }
    expect(sanitized).toEqual({ label: 'safe', self: '[circular]' })
    expect(input.self).toBe(input)
  })
})
