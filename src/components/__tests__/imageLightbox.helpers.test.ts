import test from 'node:test'
import assert from 'node:assert/strict'
import type { LightboxImage } from '../ImageLightbox'
import {
  buildRegenerateUrl,
  getFixImageHref,
  getDisplayImageUrl,
  getDownloadImageUrl,
  getKeyboardAction,
  getNextApprovalStatus,
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
    signed_url: 'https://example.com/signed',
    public_url: 'https://example.com/public',
  })
  assert.equal(getDisplayImageUrl(image), 'https://example.com/preview-public')
  assert.equal(getDownloadImageUrl(image), 'https://example.com/signed')
  assert.equal(
    getDownloadImageUrl(image, { download_url: 'https://example.com/download', signed_url: 'https://example.com/fresh-signed' }),
    'https://example.com/download'
  )
})

test('shouldRequestSignedUrls only requests when nothing renderable exists', () => {
  assert.equal(shouldRequestSignedUrls(buildImage(), true), true)
  assert.equal(shouldRequestSignedUrls(buildImage({ public_url: 'https://example.com/public' }), true), false)
  assert.equal(shouldRequestSignedUrls(buildImage(), false), false)
})

test('image URL helpers reject unsafe protocols and encode generated routes safely', () => {
  assert.equal(getDisplayImageUrl(buildImage({ public_url: 'javascript:alert(1)' })), null)
  assert.equal(
    getDownloadImageUrl(buildImage({ download_url: 'https://example.com/file.png?token=abc' })),
    'https://example.com/file.png?token=abc'
  )
  assert.equal(sanitizeRouteSegment('product/../1'), 'product%2F..%2F1')
  assert.equal(
    getFixImageHref({ projectId: 'proj/1', productId: 'prod/1', imageId: 'image/1' }),
    '/projects/proj%2F1/products/prod%2F1/fix-image?sourceImageId=image%2F1'
  )
  assert.equal(
    buildRegenerateUrl({
      projectId: 'proj/1',
      image: buildImage({
        productId: 'prod/1',
        prompt: 'bright mug & saucer',
        reference_set_id: 'ref-1',
        texture_set_id: null,
        product_image_count: 4,
        texture_image_count: 0,
      }),
    }),
    '/projects/proj%2F1/products/prod%2F1/generate?prompt=bright+mug+%26+saucer&reference_set_id=ref-1&product_image_count=4&texture_image_count=0'
  )
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
