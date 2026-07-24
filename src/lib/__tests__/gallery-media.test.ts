import { describe, it, expect } from 'vitest'
import {
  SIGNED_URL_TTL_SECONDS,
  toSignedUrlMap,
  collectGalleryMediaPaths,
  resolveGallerySignedUrls,
  GALLERY_IMAGE_SELECT,
} from '@/lib/gallery-media'

describe('SIGNED_URL_TTL_SECONDS', () => {
  it('is six hours', () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(6 * 60 * 60)
  })
})

describe('GALLERY_IMAGE_SELECT', () => {
  it('includes the storage path and approval columns the gallery renders', () => {
    for (const column of ['id', 'storage_path', 'thumb_storage_path', 'preview_storage_path', 'approval_status', 'media_type']) {
      expect(GALLERY_IMAGE_SELECT).toContain(column)
    }
  })
})

describe('toSignedUrlMap', () => {
  it('maps path to signedUrl', () => {
    const map = toSignedUrlMap([
      { path: 'a/b.webp', signedUrl: 'https://x/a' },
      { path: 'c/d.webp', signedUrl: 'https://x/c' },
    ])
    expect(map.get('a/b.webp')).toBe('https://x/a')
    expect(map.get('c/d.webp')).toBe('https://x/c')
    expect(map.size).toBe(2)
  })

  it('drops entries with a missing path or url', () => {
    const map = toSignedUrlMap([
      { path: null, signedUrl: 'https://x/a' },
      { path: 'ok', signedUrl: null },
      { path: '', signedUrl: 'https://x/b' },
      null,
      { path: 'kept', signedUrl: 'https://x/kept' },
    ])
    expect(map.size).toBe(1)
    expect(map.get('kept')).toBe('https://x/kept')
  })

  it('returns an empty map for null/undefined/empty input', () => {
    expect(toSignedUrlMap(null).size).toBe(0)
    expect(toSignedUrlMap(undefined).size).toBe(0)
    expect(toSignedUrlMap([]).size).toBe(0)
  })
})

const imageRecord = (overrides: Record<string, unknown> = {}) => ({
  storage_path: 'orig.png',
  thumb_storage_path: 'thumb.webp',
  preview_storage_path: 'preview.webp',
  media_type: 'image',
  ...overrides,
})

describe('collectGalleryMediaPaths', () => {
  it('signs thumb and preview for images, not the original', () => {
    const { imagePaths, videoPaths } = collectGalleryMediaPaths([imageRecord()])
    expect(imagePaths.sort()).toEqual(['preview.webp', 'thumb.webp'])
    expect(videoPaths).toEqual([])
  })

  it('falls back to the original only when no derivatives exist', () => {
    const { imagePaths } = collectGalleryMediaPaths([
      imageRecord({ thumb_storage_path: null, preview_storage_path: null }),
      imageRecord({ thumb_storage_path: null, preview_storage_path: 'p2.webp', storage_path: 'orig2.png' }),
    ])
    expect(imagePaths.sort()).toEqual(['orig.png', 'p2.webp'])
  })

  it('routes video thumbnails to the video bucket list', () => {
    const { imagePaths, videoPaths } = collectGalleryMediaPaths([
      imageRecord({ media_type: 'video', storage_path: 'v.mp4', thumb_storage_path: 'v-thumb.webp', preview_storage_path: null }),
    ])
    expect(imagePaths).toEqual([])
    expect(videoPaths).toEqual(['v-thumb.webp'])
  })

  it('deduplicates repeated paths', () => {
    const { imagePaths } = collectGalleryMediaPaths([imageRecord(), imageRecord()])
    expect(imagePaths.sort()).toEqual(['preview.webp', 'thumb.webp'])
  })
})

describe('resolveGallerySignedUrls', () => {
  const imageMap = new Map([
    ['orig.png', 'https://x/orig'],
    ['thumb.webp', 'https://x/thumb'],
    ['preview.webp', 'https://x/preview'],
  ])
  const videoMap = new Map([['v-thumb.webp', 'https://x/v-thumb']])

  it('resolves all three URLs for an image', () => {
    expect(resolveGallerySignedUrls(imageRecord(), imageMap, videoMap)).toEqual({
      public_url: 'https://x/orig',
      preview_public_url: 'https://x/preview',
      thumb_public_url: 'https://x/thumb',
    })
  })

  it('returns null for unsigned or missing paths', () => {
    expect(resolveGallerySignedUrls(
      imageRecord({ storage_path: null, preview_storage_path: 'not-signed.webp' }),
      imageMap,
      videoMap
    )).toEqual({
      public_url: null,
      preview_public_url: null,
      thumb_public_url: 'https://x/thumb',
    })
  })

  it('only exposes the video-bucket thumbnail for videos', () => {
    expect(resolveGallerySignedUrls(
      imageRecord({ media_type: 'video', storage_path: 'v.mp4', thumb_storage_path: 'v-thumb.webp' }),
      imageMap,
      videoMap
    )).toEqual({
      public_url: null,
      preview_public_url: null,
      thumb_public_url: 'https://x/v-thumb',
    })
  })
})
