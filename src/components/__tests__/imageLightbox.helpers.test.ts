import test from 'node:test'
import assert from 'node:assert/strict'
import type { LightboxImage } from '../ImageLightbox'
import {
  getDisplayImageUrl,
  getDownloadImageUrl,
  getKeyboardAction,
  getNextApprovalStatus,
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
    preview_public_url: 'preview-public',
    signed_url: 'signed',
    public_url: 'public',
  })
  assert.equal(getDisplayImageUrl(image), 'preview-public')
  assert.equal(getDownloadImageUrl(image), 'signed')
  assert.equal(
    getDownloadImageUrl(image, { download_url: 'download', signed_url: 'fresh-signed' }),
    'download'
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
