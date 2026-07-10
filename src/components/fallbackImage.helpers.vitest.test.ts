import { describe, expect, it } from 'vitest'
import {
  getFallbackImageSources,
  normalizeFallbackImageSource,
} from './FallbackImage'

describe('FallbackImage source filtering', () => {
  it('keeps safe absolute, blob, and root-relative image sources', () => {
    expect(getFallbackImageSources([
      ' https://example.com/image.png ',
      'http://example.com/thumb.png',
      'blob:https://app.local/preview',
      '/api/images/123',
    ])).toEqual([
      'https://example.com/image.png',
      'http://example.com/thumb.png',
      'blob:https://app.local/preview',
      '/api/images/123',
    ])
  })

  it('drops unsafe, blank, duplicate, and protocol-relative candidates', () => {
    expect(getFallbackImageSources([
      'javascript:alert(1)',
      'data:image/svg+xml,<svg></svg>',
      'ftp://example.com/file.png',
      '//example.com/protocol-relative.png',
      'https://example.com/safe.png',
      ' https://example.com/safe.png ',
      '',
      null,
      undefined,
    ])).toEqual(['https://example.com/safe.png'])
  })

  it('returns null for relative paths that are not root-relative', () => {
    expect(normalizeFallbackImageSource('images/local.png')).toBeNull()
  })
})
