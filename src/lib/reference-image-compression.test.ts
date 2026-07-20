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
// Captures the payload passed to .update() so tests can assert on field names.
let capturedDbUpdatePayload: Record<string, unknown> | undefined

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
      update: (data: Record<string, unknown>) => {
        capturedDbUpdatePayload = data
        return {
          eq: (_col: string, _val: string) => mockDbUpdate(),
        }
      },
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
  capturedDbUpdatePayload = undefined
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
    expect(result.error).toBe('object not found')
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
    expect(result.error).toBe('bucket quota exceeded')
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
    mockRemove.mockResolvedValue({ error: null })
  })

  it('returns wasCompressed=false with an error when DB update fails (upload rolled back)', async () => {
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('FK violation')
    expect(result.newStoragePath).toBeUndefined()
  })

  it('removes the orphaned compressed upload when DB update fails and the path changed', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    // The NEW object is removed; the original the DB still points at is kept.
    expect(mockRemove).toHaveBeenCalledTimes(1)
    expect(mockRemove).toHaveBeenCalledWith([expectedNewPath])
  })

  it('does NOT remove anything when DB update fails but the path was unchanged (.webp in place)', async () => {
    const webpPath = 'org/product/ref-image.webp'
    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, webpPath)

    // Upload replaced the original in place — removing it would delete the
    // customer's only copy. The result keeps the (valid) path and the error.
    expect(mockRemove).not.toHaveBeenCalled()
    expect(result.wasCompressed).toBe(true)
    expect(result.newStoragePath).toBe(webpPath)
    expect(result.error).toBe('FK violation')
  })

  it('still surfaces the DB error when the orphan cleanup itself fails', async () => {
    mockRemove.mockResolvedValue({ error: { message: 'storage unavailable' } })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('FK violation')
  })

  it('still surfaces the DB error when the orphan cleanup throws', async () => {
    mockRemove.mockRejectedValue(new Error('network down'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('FK violation')
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

  it('updates the DB record with storage_path, mime_type, and file_size fields', async () => {
    await processReferenceImageCompression(FAKE_IMAGE_ID, originalPath)
    expect(capturedDbUpdatePayload).toEqual({
      storage_path: expectedNewPath,
      mime_type: 'image/webp',
      file_size: 800_000,
    })
  })
})

// ---------------------------------------------------------------------------
// Compression error path
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — compression failure', () => {
  it('returns wasCompressed=false with the error message when compression throws', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('valid-png'), error: null })
    mockCompress.mockRejectedValue(new Error('unsupported format'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('unsupported format')
    expect(result.imageId).toBe(FAKE_IMAGE_ID)
  })

  it('reports originalSize and compressedSize equal to the buffer length on compression error', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('valid-png-data'), error: null })
    mockCompress.mockRejectedValue(new Error('pixel bomb detected'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.originalSize).toBeGreaterThan(0)
    expect(result.originalSize).toBe(result.compressedSize)
  })

  it('does not attempt upload or DB update when compression throws', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('data'), error: null })
    mockCompress.mockRejectedValue(new Error('compression error'))

    await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('sanitizes and surfaces a non-Error (string) rejection', async () => {
    // sanitizePublicErrorMessage accepts unknown — string rejections are
    // surfaced (sanitized) rather than being dropped for the generic fallback,
    // matching how every other call site in the codebase invokes it.
    mockDownload.mockResolvedValue({ data: makeBlob('data'), error: null })
    mockCompress.mockRejectedValue('string-error')

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)
    expect(result.error).toBe('string-error')
  })

  it('falls back to "Compression failed" for a rejection with no usable message', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('data'), error: null })
    mockCompress.mockRejectedValue('')

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)
    expect(result.error).toBe('Compression failed')
  })
})

// ---------------------------------------------------------------------------
// Transient-error retry behaviour
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — transient-error retries', () => {
  it('retries a transient download error and succeeds on a later attempt', async () => {
    mockDownload
      .mockResolvedValueOnce({ data: null, error: { message: 'network timeout' } })
      .mockResolvedValueOnce({ data: makeBlob('png-data'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('png-data'),
      mimeType: 'image/png',
      extension: 'png',
      originalSize: 8,
      compressedSize: 8,
      wasCompressed: false,
    })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(2)
    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('does NOT retry a deterministic (non-transient) download error', async () => {
    mockDownload.mockResolvedValue({ data: null, error: { message: 'object not found' } })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(result.error).toBe('object not found')
  })

  it('gives up after the max attempts when a transient download error persists', async () => {
    mockDownload.mockResolvedValue({ data: null, error: { message: 'service unavailable (503)' } })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(3)
    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('service unavailable (503)')
  })

  it('retries a transient upload error and succeeds on a later attempt', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('compressed-webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 200,
      compressedSize: 50,
      wasCompressed: true,
    })
    mockUpload
      .mockResolvedValueOnce({ error: { message: 'ECONNRESET' } })
      .mockResolvedValueOnce({ error: null })
    mockDbUpdate.mockResolvedValue({ error: null })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, 'org/product/ref-image.png')

    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(result.wasCompressed).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('does NOT retry a deterministic upload error (quota)', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue({
      buffer: Buffer.from('compressed-webp'),
      mimeType: 'image/webp',
      extension: 'webp',
      originalSize: 200,
      compressedSize: 50,
      wasCompressed: true,
    })
    mockUpload.mockResolvedValue({ error: { message: 'bucket quota exceeded' } })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, 'org/product/ref-image.png')

    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(result.error).toBe('bucket quota exceeded')
  })
})

// ---------------------------------------------------------------------------
// No-throw contract — storage-client exceptions become error results
//
// The batch compress routes run this function through mapWithConcurrency and
// rely on failures being reported via the result's `error` field: a rethrow
// would abort the whole pool. These tests pin that contract for exceptions
// (as opposed to `{ error }` results) thrown by the storage client.
// ---------------------------------------------------------------------------

describe('processReferenceImageCompression — no-throw contract on storage exceptions', () => {
  const compressedResult = {
    buffer: Buffer.from('compressed-webp'),
    mimeType: 'image/webp',
    extension: 'webp',
    originalSize: 200,
    compressedSize: 50,
    wasCompressed: true,
  }

  it('resolves to an error result when download throws a non-retriable exception', async () => {
    mockDownload.mockRejectedValue(new Error('unexpected boom'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('unexpected boom')
  })

  it('resolves to an error result when a retriable download exception persists past max attempts', async () => {
    mockDownload.mockRejectedValue(new TypeError('fetch failed'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(3)
    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('fetch failed')
  })

  it('retries a retriable download exception and succeeds on a later attempt', async () => {
    mockDownload
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ data: makeBlob('png-data'), error: null })
    mockCompress.mockResolvedValue({
      ...compressedResult,
      originalSize: 8,
      compressedSize: 8,
      wasCompressed: false,
    })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(mockDownload).toHaveBeenCalledTimes(2)
    expect(result.error).toBeUndefined()
  })

  it('resolves to an error result (no DB update) when upload throws', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue(compressedResult)
    mockUpload.mockRejectedValue(new Error('upload exploded'))

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, FAKE_STORAGE_PATH)

    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('upload exploded')
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('cleans up the orphaned upload when the DB update throws after a successful upload', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob('big-png'), error: null })
    mockCompress.mockResolvedValue(compressedResult)
    mockUpload.mockResolvedValue({ error: null })
    mockDbUpdate.mockRejectedValue(new Error('db connection lost'))
    mockRemove.mockResolvedValue({ error: null })

    const result = await processReferenceImageCompression(FAKE_IMAGE_ID, 'org/product/ref-image.png')

    // The exception flows through the same path as a returned dbError:
    // the unreachable compressed copy is removed, and the failure is reported.
    expect(mockRemove).toHaveBeenCalledWith(['org/product/ref-image.webp'])
    expect(result.wasCompressed).toBe(false)
    expect(result.error).toBe('db connection lost')
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
    // No extension at all — .webp must be APPENDED, not silently no-opped:
    // an unchanged path would make the upsert upload overwrite the original.
    { input: 'org/product/image-no-ext', expected: 'org/product/image-no-ext.webp' },
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
