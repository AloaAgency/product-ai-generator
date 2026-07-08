import { describe, expect, it } from 'vitest'
import type { LightboxImage } from './ImageLightbox'
import {
  buildRegenerateUrl,
  getDisplayImageUrl,
  getDownloadImageUrl,
  getFixImageHref,
  getFullImageUrl,
  getKeyboardAction,
  getLightboxDisplayName,
  getLightboxThumbnailUrl,
  getLightboxWarmupIndexes,
  getNextApprovalStatus,
  getPreviewImageUrl,
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

describe('imageLightbox.helpers — url fallback chains', () => {
  it('walks the preview fallback order and skips unsafe candidates', () => {
    const image = buildImage({
      preview_signed_url: 'javascript:alert(1)',
      preview_public_url: '  ',
      thumb_signed_url: 'https://example.com/thumb-signed.png',
      thumb_public_url: 'https://example.com/thumb-public.png',
    })
    // First two candidates are unsafe/blank, so the thumb signed url wins.
    expect(getPreviewImageUrl(image)).toBe('https://example.com/thumb-signed.png')
  })

  it('prefers the full signed url and falls back to public for getFullImageUrl', () => {
    expect(getFullImageUrl(buildImage({ signed_url: 'https://example.com/s.png', public_url: 'https://example.com/p.png' }))).toBe(
      'https://example.com/s.png'
    )
    expect(getFullImageUrl(buildImage({ signed_url: 'ftp://nope', public_url: 'https://example.com/p.png' }))).toBe(
      'https://example.com/p.png'
    )
  })

  it('falls back from preview to full image for the display url', () => {
    // No preview/thumb urls -> display url falls through to the full signed url.
    expect(getDisplayImageUrl(buildImage({ signed_url: 'https://example.com/full.png' }))).toBe(
      'https://example.com/full.png'
    )
  })

  it('thumbnail url falls back to full-size urls when no thumbnail exists', () => {
    expect(getLightboxThumbnailUrl(buildImage({ public_url: 'https://example.com/full-public.png' }))).toBe(
      'https://example.com/full-public.png'
    )
  })

  it('download url honors the full priority chain across fresh signed urls and image fields', () => {
    const image = buildImage({
      download_url: 'https://example.com/image-download.png',
      signed_url: 'https://example.com/image-signed.png',
    })
    // Fresh server-provided urls outrank the stored image fields...
    expect(getDownloadImageUrl(image, { download_url: 'https://example.com/fresh-download.png' })).toBe(
      'https://example.com/fresh-download.png'
    )
    expect(getDownloadImageUrl(image, { signed_url: 'https://example.com/fresh-signed.png' })).toBe(
      'https://example.com/fresh-signed.png'
    )
    // ...and with no fresh urls it falls back to the stored download url.
    expect(getDownloadImageUrl(image, null)).toBe('https://example.com/image-download.png')
  })

  it('accepts blob: urls as safe display candidates', () => {
    expect(getDisplayImageUrl(buildImage({ preview_public_url: 'blob:https://app/local-preview' }))).toBe(
      'blob:https://app/local-preview'
    )
  })
})

describe('imageLightbox.helpers — keyboard action map', () => {
  const base = { isNotesFocused: false, isRejected: false, hasDelete: false }

  it('maps navigation and approval keys with the correct preventDefault behavior', () => {
    expect(getKeyboardAction({ ...base, key: 'Escape' })).toEqual({ action: 'close', preventDefault: false })
    expect(getKeyboardAction({ ...base, key: 'ArrowRight' })).toEqual({ action: 'next', preventDefault: true })
    expect(getKeyboardAction({ ...base, key: 'Enter' })).toEqual({ action: 'approve', preventDefault: true })
  })

  it('maps single-letter shortcuts case-insensitively without preventing default', () => {
    expect(getKeyboardAction({ ...base, key: 'A' })).toEqual({ action: 'approve', preventDefault: false })
    expect(getKeyboardAction({ ...base, key: 'r' })).toEqual({ action: 'reject', preventDefault: false })
    expect(getKeyboardAction({ ...base, key: 'D' })).toEqual({ action: 'download', preventDefault: false })
    expect(getKeyboardAction({ ...base, key: 'c' })).toEqual({ action: 'requestChanges', preventDefault: false })
  })

  it('routes Delete to reject unless the image is already rejected AND delete is supported', () => {
    expect(getKeyboardAction({ ...base, key: 'Delete', isRejected: false, hasDelete: true })).toEqual({
      action: 'reject',
      preventDefault: true,
    })
    expect(getKeyboardAction({ ...base, key: 'Backspace', isRejected: true, hasDelete: false })).toEqual({
      action: 'reject',
      preventDefault: true,
    })
    expect(getKeyboardAction({ ...base, key: 'Delete', isRejected: true, hasDelete: true })).toEqual({
      action: 'delete',
      preventDefault: true,
    })
  })

  it('blurs the notes field on Escape/Enter and ignores other keys while typing', () => {
    expect(getKeyboardAction({ ...base, key: 'Escape', isNotesFocused: true })).toEqual({
      action: 'blurNotes',
      preventDefault: true,
    })
    expect(getKeyboardAction({ ...base, key: 'ArrowLeft', isNotesFocused: true })).toEqual({
      action: 'none',
      preventDefault: false,
    })
  })

  it('ignores unmapped keys', () => {
    expect(getKeyboardAction({ ...base, key: 'z' })).toEqual({ action: 'none', preventDefault: false })
  })
})

describe('imageLightbox.helpers — view model helpers', () => {
  it('toggles an active approval status off and switches between statuses', () => {
    expect(getNextApprovalStatus('approved', 'approved')).toBe(null)
    expect(getNextApprovalStatus('rejected', 'rejected')).toBe(null)
    expect(getNextApprovalStatus(null, 'approved')).toBe('approved')
    expect(getNextApprovalStatus('approved', 'rejected')).toBe('rejected')
  })

  it('prefers an explicit file name and otherwise derives a variation label', () => {
    expect(getLightboxDisplayName({ fileName: 'hero.png', variationNumber: 2, currentIndex: 0 })).toBe('hero.png')
    expect(getLightboxDisplayName({ fileName: null, variationNumber: 4, currentIndex: 0 })).toBe('Variation 4')
    // No variation number -> fall back to 1-based index.
    expect(getLightboxDisplayName({ fileName: null, variationNumber: null, currentIndex: 6 })).toBe('Variation 7')
  })

  it('produces warmup indexes centered on the current index, including negatives near the start', () => {
    expect(getLightboxWarmupIndexes(0)).toEqual([0, -1, 1, -2, 2])
  })

  it('returns null fix-image hrefs when any id segment is missing', () => {
    expect(getFixImageHref({ projectId: 'p', productId: 'prod', imageId: null })).toBe(null)
    expect(getFixImageHref({ projectId: 'p', productId: '  ', imageId: 'img' })).toBe(null)
  })

  it('builds a regenerate url with no query params when prompt and reference sets are absent', () => {
    expect(buildRegenerateUrl({ projectId: 'proj', image: buildImage({ productId: 'prod' }) })).toBe(
      '/projects/proj/products/prod/generate?'
    )
  })
})
