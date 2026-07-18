import { describe, expect, it } from 'vitest'
import {
  getSafeDownloadErrorMessage,
  getSafeErrorContext,
  getSafeErrorMessage,
  getSafeQueueErrorMessage,
} from './errorDisplay.helpers'

// The node:test suite under src/components/__tests__/ is excluded from vitest,
// so these vitest specs are what actually run in `npm test`. They lock down the
// customer-safe message redaction and context sanitization that protect us from
// leaking internal/secret data into the UI.

const GENERIC = 'Something went wrong. Try again or contact support if the issue persists.'

describe('getSafeErrorMessage — message sanitization', () => {
  it('returns the fallback for nullish or whitespace-only input', () => {
    expect(getSafeErrorMessage(null)).toBe(GENERIC)
    expect(getSafeErrorMessage(undefined)).toBe(GENERIC)
    expect(getSafeErrorMessage('   ')).toBe(GENERIC)
  })

  it('hides messages that embed URLs, markup, or database internals', () => {
    expect(getSafeErrorMessage('Upload failed: see https://internal.example/logs/123')).toBe(GENERIC)
    expect(getSafeErrorMessage('<div>boom</div>')).toBe(GENERIC)
    expect(getSafeErrorMessage('SELECT id FROM users WHERE deleted = false ORDER BY id')).toBe(GENERIC)
    expect(getSafeErrorMessage('Postgres connection refused')).toBe(GENERIC)
    expect(getSafeErrorMessage('Authorization: Bearer abc123')).toBe(GENERIC)
  })

  it('does not expose webhook verification-stage diagnostics', () => {
    expect(getSafeErrorMessage('Webhook timestamp outside the allowed tolerance')).toBe(GENERIC)
    expect(getSafeErrorMessage('HMAC mismatch')).toBe(GENERIC)
    expect(getSafeErrorMessage('Request timestamp expired')).toBe(GENERIC)
    expect(getSafeErrorMessage('Replayed request detected')).toBe(GENERIC)
  })

  it('preserves a clean customer-safe message verbatim', () => {
    const safe = 'Your image is still processing. Please try again in a moment.'
    expect(getSafeErrorMessage(safe)).toBe(safe)
  })

  it('truncates an over-long clean message and appends an ellipsis without exceeding the cap', () => {
    const result = getSafeErrorMessage('a'.repeat(300))
    expect(result.length).toBeLessThanOrEqual(240)
    expect(result.endsWith('…')).toBe(true)
  })

  it('collapses runs of whitespace before evaluating length', () => {
    expect(getSafeErrorMessage('Please   retry\n\nthe upload')).toBe('Please retry the upload')
  })

  it('uses contextual fallbacks for queue and download surfaces', () => {
    expect(getSafeQueueErrorMessage(null)).toBe('Generation failed. Try again or review your prompt and settings.')
    expect(getSafeDownloadErrorMessage('SQLSTATE 23505')).toBe('Download failed. Please try again.')
  })
})

describe('getSafeErrorContext — context sanitization', () => {
  it('returns null when there is no context', () => {
    expect(getSafeErrorContext(null)).toBe(null)
    expect(getSafeErrorContext(undefined)).toBe(null)
  })

  it('redacts secret-bearing keys and values at any depth without leaking the original', () => {
    const context = getSafeErrorContext({
      apiKey: 'sk-live-123',
      nested: {
        password: 'hunter2',
        note: 'the secret sauce is safe',
        safeField: 'visible-value',
      },
    })

    expect(context).not.toBe(null)
    expect(context).toContain('[redacted]')
    expect(context).toContain('visible-value')
    expect(context).not.toContain('sk-live-123')
    expect(context).not.toContain('hunter2')
  })

  it('strips signed-url query secrets from otherwise-safe string values', () => {
    const context = getSafeErrorContext({
      requestUrl: 'https://cdn.example/file.png?X-Amz-Signature=topsecretsig&size=1024',
    })

    expect(context).not.toBe(null)
    expect(context).not.toContain('topsecretsig')
    expect(context).toContain('[redacted]')
  })

  it('truncates oversized context payloads to the cap with an ellipsis', () => {
    const context = getSafeErrorContext({ detail: 'x'.repeat(2000) })

    expect(context).not.toBe(null)
    expect((context ?? '').length).toBeLessThanOrEqual(1200)
    expect((context ?? '').endsWith('…')).toBe(true)
  })

  it('returns null instead of throwing when the context cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(getSafeErrorContext(circular)).toBe(null)
  })
})
