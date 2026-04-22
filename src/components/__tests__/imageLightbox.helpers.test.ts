import test from 'node:test'
import assert from 'node:assert/strict'
import type { LightboxImage } from '../ImageLightbox'
import {
  getFixImageHref,
  getDisplayImageUrl,
  getDownloadImageUrl,
  getFullImageUrl,
  getKeyboardAction,
  getLightboxDisplayName,
  getLightboxThumbnailUrl,
  getLightboxWarmupIndexes,
  getNextApprovalStatus,
  getPreviewImageUrl,
  sanitizeRouteSegment,
  shouldRequestSignedUrls,
} from '../imageLightbox.helpers.js'

const buildImage = (overrides: Partial<LightboxImage> = {}): LightboxImage => ({
  id: 'image-1',
  file_name: 'image.png',
  variation_number: 1,
  approval_status: null,
  ...overrides,
})

test('image URL helpers honor preview and download fallback order', () => {
  const image = buildImage({
    preview_public_url: 'https://example.com/preview-public',
    signed_url: 'https://example.com/full-signed',
    public_url: 'https://example.com/full-public',
  })
  assert.equal(getPreviewImageUrl(image), 'https://example.com/preview-public')
  assert.equal(getFullImageUrl(image), 'https://example.com/full-signed')
  assert.equal(getDisplayImageUrl(image), 'https://example.com/preview-public')
  assert.equal(getDownloadImageUrl(image), 'https://example.com/full-signed')
  assert.equal(
    getDownloadImageUrl(image, { download_url: 'https://example.com/download', signed_url: 'https://example.com/fresh-signed' }),
    'https://example.com/download'
  )
})

test('image URL helpers reject unsafe protocols and preserve safe absolute or relative URLs', () => {
  assert.equal(
    getDisplayImageUrl(buildImage({ public_url: 'javascript:alert(1)' })),
    null
  )
  assert.equal(
    getDownloadImageUrl(buildImage({ download_url: 'https://example.com/file.png?token=abc' })),
    'https://example.com/file.png?token=abc'
  )
  assert.equal(
    getDisplayImageUrl(buildImage({ preview_public_url: '/api/images/123' })),
    '/api/images/123'
  )
  assert.equal(
    getLightboxThumbnailUrl(buildImage({ thumb_public_url: 'https://example.com/thumb.png' })),
    'https://example.com/thumb.png'
  )
})

test('shouldRequestSignedUrls only requests when nothing renderable exists', () => {
  assert.equal(shouldRequestSignedUrls(buildImage(), true), true)
  assert.equal(shouldRequestSignedUrls(buildImage({ public_url: 'public' }), true), false)
  assert.equal(shouldRequestSignedUrls(buildImage(), false), false)
})

test('keyboard delete path only permanently deletes already-rejected images with delete support', () => {
  assert.deepEqual(
    getKeyboardAction({ key: 'Delete', isNotesFocused: false, isRejected: true, hasDelete: true }),
    { action: 'delete', preventDefault: true }
  )
  assert.deepEqual(
    getKeyboardAction({ key: 'Backspace', isNotesFocused: false, isRejected: false, hasDelete: true }),
    { action: 'reject', preventDefault: true }
  )
})

test('keyboard navigation prevents scroll and supports first/last shortcuts', () => {
  assert.deepEqual(
    getKeyboardAction({ key: 'ArrowLeft', isNotesFocused: false, isRejected: false, hasDelete: false }),
    { action: 'prev', preventDefault: true }
  )
  assert.deepEqual(
    getKeyboardAction({ key: 'Home', isNotesFocused: false, isRejected: false, hasDelete: false }),
    { action: 'first', preventDefault: true }
  )
  assert.deepEqual(
    getKeyboardAction({ key: 'End', isNotesFocused: false, isRejected: false, hasDelete: false }),
    { action: 'last', preventDefault: true }
  )
})

test('keyboard handling stops modal shortcuts while the notes field is focused', () => {
  assert.deepEqual(
    getKeyboardAction({ key: 'Enter', isNotesFocused: true, isRejected: true, hasDelete: true }),
    { action: 'blurNotes', preventDefault: true }
  )
  assert.deepEqual(
    getKeyboardAction({ key: 'a', isNotesFocused: true, isRejected: true, hasDelete: true }),
    { action: 'none', preventDefault: false }
  )
})

test('approval toggles clear an already-selected status', () => {
  assert.equal(getNextApprovalStatus('approved', 'approved'), null)
  assert.equal(getNextApprovalStatus('rejected', 'approved'), 'approved')
})

test('sanitizeRouteSegment encodes reserved characters and rejects blank values', () => {
  assert.equal(sanitizeRouteSegment('product/../1'), 'product%2F..%2F1')
  assert.equal(sanitizeRouteSegment('  '), null)
})

test('lightbox view helpers derive labels, warmup indexes, and fix-image hrefs safely', () => {
  assert.equal(
    getLightboxDisplayName({ fileName: 'named.png', variationNumber: 3, currentIndex: 0 }),
    'named.png'
  )
  assert.equal(
    getLightboxDisplayName({ fileName: null, variationNumber: 3, currentIndex: 0 }),
    'Variation 3'
  )
  assert.deepEqual(getLightboxWarmupIndexes(5), [5, 4, 6, 3, 7])
  assert.equal(
    getFixImageHref({ projectId: 'proj', productId: 'product', imageId: 'image' }),
    '/projects/proj/products/product/fix-image?sourceImageId=image'
  )
  assert.equal(
    getFixImageHref({ projectId: ' ', productId: 'product', imageId: 'image' }),
    null
  )
})
