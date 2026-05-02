/**
 * Tests for reference-image-compression.ts
 *
 * The module depends on Supabase (storage + DB) and compressReferenceImage.
 * We mock both so that tests exercise only the orchestration logic in
 * processReferenceImageCompression without hitting external services.
 *
 * Coverage goals:
 *  - Download failures are surfaced correctly
 *  - Images already within limits are returned without uploading
 *  - Compressed images are uploaded under a .webp path
 *  - Old file is deleted when the extension changed
 *  - Old file is NOT deleted when extension was already .webp
 *  - Upload failures are reported correctly (wasCompressed=false + error)
 *  - DB update failures are reported (wasCompressed=true + error, newStoragePath present)
 *  - Happy path returns full result with newStoragePath
 *  - Storage path extension replacement is correct for various extensions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Supabase service client BEFORE importing the module under test so that
// the mock is in place when the module is first evaluated.
// ---------------------------------------------------------------------------

const mockDownload = vi.fn()
const mockUpload = vi.fn()
const mockRemove = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    storage: {
      from: (_bucket: string) => ({
        download: mockDownload,
        upload: mockUpload,
        remove: mockRemove,
      }),
    },
    from: (_table: string) => ({
      update: (_data: unknown) => ({
        eq: (_col: string, _val: string) => mockDbUpdate(),
      }),
    }),
  }),
}))

// ---------------------------------------------------------------------------
// Mock compressReferenceImage so we can control its output per test
// ---------------------------------------------------------------------------

const mockCompress = vi.fn()

vi.mock('@/lib/image-utils', () => ({
  compressReferenceImage: (...args: unknown[]) => mockCompress(...args),
}))

// ---------------------------------------------------------------------------
// Import the module AFTER mocks are established
// ---------------------------------------------------------------------------

import { processReferenceImageCompression } from './reference-image-compression'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlob(content: string): Blob {
  return new Blob([content], { type: 'application/octet-stream' })
}

const FAKE_IMAGE_ID = 'img-uuid-1234'
const FAKE_STORAGE_PATH = 'org/product/ref-image.png'

/** Reset all mocks before each test */
beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Download failures
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — download failures', () => {
  it('returns an error result when download returns an error object', async () => {
    mockDownload.mockResolvedValue({
      data: null,
      error: { message: 'object not found' },
    })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.originalSize).toBe(0)
    expect(result.compressedSize).toBe(0)
    expect(result.error).toBe('Download failed')
    expect(result.imageId).toBe(FAKE_IMAGE_ID)
  })

  it('returns an error result when download returns null data with no error', async () => {
    mockDownload.mockResolvedValue({ data: null, error: null })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('Download failed')
  })
})

// ---------------------------------------------------------------------------
// No-op path: image already within limits
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — image within limits (no compression)', () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue({ data: makeBlob('fake-png-data'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('fake-png-data'),
      mimeType: 'image/png',
      extension: 'png',
      originalSize: 13,
      compressedSize: 13,
      wasCompressed: false,
    })
  })

  it('returns wasCompressed=false and does not upload anything', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.originalSize).toBe(13)
    expect(result.compressedSize).toBe(13)
    expect(result.error).toBeUndefined()
    expect(result.newStoragePath).toBeUndefined()
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns the imageId unchanged', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)
    expect(result.imageId).toBe(FAKE_IMAGE_ID)
  })
})

// ---------------------------------------------------------------------------
// Upload failure path
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — upload failure', () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('compressed-webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 7,
      compressedSize: 15,
      wasCompressed: true,
    })
    mockUpload.mockResolvedValue({ error: { message: 'bucket quota exceeded' } })
  })

  it('returns wasCompressed=false and an error when upload fails', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('Upload failed')
    expect(result.imageId).toBe(FAKE_IMAGE_ID)
    expect(result.originalSize).toBe(7)
    expect(result.compressedSize).toBe(15)
  })

  it('does not attempt to delete the old file when upload fails', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('does not attempt to update the DB when upload fails', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DB update failure path
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — DB update failure', () => {
  const originalPath = 'org/product/ref-image.png'
  const expectedNewPath = 'org/product/ref-image.webp'

  beforeEach(() => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('compressed-webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 200,
      compressedSize: 50,
      wasCompressed: true,
    })
    mockUpload.mockResolvedValue({ error: null })
    mockDbUpdate.mockResolvedValue({ error: { message: 'FK violation' } })
  })

  it('returns wasCompressed=true with an error when DB update fails', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)

    expect(result.wasCompressed).toBe(true)
    expect(result.error).toBe('DB update failed')
  })

  it('still includes newStoragePath in the result even when DB update fails', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(result.newStoragePath).toBe(expectedNewPath)
  })
})

// ---------------------------------------------------------------------------
// Happy path: full successful compression + re-upload
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — happy path', () => {
  const originalPath = 'org/product/ref-image.png'
  const expectedNewPath = 'org/product/ref-image.webp'

  beforeEach(() => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('compressed-webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 6_000_000,
      compressedSize: 800_000,
      wasCompressed: true,
    })
    mockUpload.mockResolvedValue({ error: null })
    mockDbUpdate.mockResolvedValue({ error: null })
  })

  it('returns wasCompressed=true with no error', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(result.wasCompressed).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns the correct newStoragePath (.webp extension)', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(result.newStoragePath).toBe(expectedNewPath)
  })

  it('reports the correct originalSize and compressedSize', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(result.originalSize).toBe(6_000_000)
    expect(result.compressedSize).toBe(800_000)
  })

  it('deletes the original file when the extension changed (png → webp)', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(mockRemove).toHaveBeenCalledWith([originalPath])
  })

  it('uploads the compressed buffer with content-type image/webp', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(mockUpload).toHaveBeenCalledWith(
      expectedNewPath,
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/webp' })
    )
  })
})

// ---------------------------------------------------------------------------
// Extension replacement logic — storage path variations
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — storage path extension replacement', () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: 'org/product/image.jpg', expected: 'org/product/image.webp' },
    { input: 'org/product/image.jpeg', expected: 'org/product/image.webp' },
    { input: 'org/product/image.PNG', expected: 'org/product/image.webp' },
    { input: 'org/product/image.webp', expected: 'org/product/image.webp' },
    { input: 'org/product/image.tiff', expected: 'org/product/image.webp' },
    // Filename with dots in it — only last extension should be replaced
    { input: 'org/product/image.v2.3.png', expected: 'org/product/image.v2.3.webp' },
  ]

  cases.forEach(({ input, expected }) => {
    it(`replaces extension in "${input}" → "${expected}"`, async () => {
      mockDownload.mockResolvedValue({ data: makeBlob('data'), error: null })
      mockCompress.mockResolvedValue({
        buffer: Buffer.from('webp'),
        mimeType: 'image/webp',
        extension: 'webp',
        originalSize: 10,
        compressedSize: 4,
        wasCompressed: true,
      })
      mockUpload.mockResolvedValue({ error: null })
      mockDbUpdate.mockResolvedValue({ error: null })

      const result = await processReferenceImageCompression(FAKE_IMAGE_ID, input)
      expect(result.newStoragePath).toBe(expected)
    })
  })

  it('does NOT delete the old file when extension was already .webp (path unchanged)', async () => {
    const webpPath = 'org/product/image.webp'

    mockDownload.mockResolvedValue({ data: makeBlob('data'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 10,
      compressedSize: 4,
      wasCompressed: true,
    })
    mockUpload.mockResolvedValue({ error: null })
    mockDbUpdate.mockResolvedValue({ error: null })

    await processReferenceImageCompression(FAKE_IMAGE_ID, webpPath)

    // newPath === oldPath → remove should NOT be called
    expect(mockRemove).not.toHaveBeenCalled()
  })
})
