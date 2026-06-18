import { describe, expect, it } from 'vitest'
import type { LightboxImage } from './ImageLightbox'
import {
  buildRegenerateUrl,
  getDownloadImageUrl,
  getKeyboardAction,
  shouldRequestSignedUrls,
} from './imageLightbox.helpers'

const buildImage = (overrides: Partial<LightboxImage> = {}): LightboxImage => ({
  id: 'image-1',
  file_name: 'image.png',
  variation_number: 1,
  approval_status: null,
  ...overrides,
})

describe('imageLightbox.helpers', () => {
  it('builds regenerate URLs with encoded ids and only the populated generation settings', () => {
    const referenceSets = [
      {
        reference_set_id: 'ref-1',
        role: 'subject' as const,
        display_order: 0,
        image_count: 4,
        subject_label: null,
      },
    ]
    expect(buildRegenerateUrl({
      projectId: 'proj/1',
      image: buildImage({
        productId: 'prod/1',
        prompt: 'bright mug & saucer',
        reference_sets: referenceSets,
      }),
    })).toBe(
      `/projects/proj%2F1/products/prod%2F1/generate?prompt=bright+mug+%26+saucer&reference_sets=${encodeURIComponent(JSON.stringify(referenceSets))}`
    )
  })

  it('falls back safely when regenerate ids are blank and preserves download fallback priority', () => {
    expect(buildRegenerateUrl({
      projectId: ' ',
      image: buildImage({ productId: 'product-1', prompt: 'test' }),
    })).toBe('#')

    expect(getDownloadImageUrl(
      buildImage({
        download_url: 'javascript:alert(1)',
        signed_url: 'https://example.com/signed.png',
        public_url: 'https://example.com/public.png',
      })
    )).toBe('https://example.com/signed.png')
  })

  it('routes the prompt-copy shortcut through the keyboard action map', () => {
    expect(getKeyboardAction({ key: 'p', isNotesFocused: false, isRejected: false, hasDelete: false }))
      .toEqual({ action: 'copyPrompt', preventDefault: false })
    expect(getKeyboardAction({ key: 'p', isNotesFocused: true, isRejected: false, hasDelete: false }))
      .toEqual({ action: 'none', preventDefault: false })
  })

  it('only requests fresh signed urls when no renderable full image exists', () => {
    expect(shouldRequestSignedUrls(buildImage({ public_url: '/api/images/123' }), true)).toBe(false)
    expect(shouldRequestSignedUrls(buildImage({ signed_url: 'ftp://unsafe.example/file' }), true)).toBe(true)
    expect(shouldRequestSignedUrls(buildImage({ public_url: 'https://example.com/image.png' }), false)).toBe(false)
  })
})
