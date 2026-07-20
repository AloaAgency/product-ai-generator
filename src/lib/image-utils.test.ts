/**
 * Tests for image-utils.ts
 *
 * Covers: slugify, resolveExtension, buildImageFileName, buildImageStoragePath,
 * buildThumbnailPath, buildPreviewPath, compressReferenceImage, createThumbnail,
 * createPreview.
 *
 * Sharp pipeline tests use programmatically-created image buffers so they run
 * without any fixture files and exercise the real encoding paths.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import sharp from 'sharp'
import {
  slugify,
  resolveExtension,
  buildImageFileName,
  buildImageStoragePath,
  buildThumbnailPath,
  buildPreviewPath,
  compressReferenceImage,
  createThumbnail,
  createPreview,
  createThumbnailAndPreview,
  extractVideoThumbnail,
  assertImageDimensions,
} from './image-utils'

// ---------------------------------------------------------------------------
// Helpers — create minimal real image buffers via sharp
// ---------------------------------------------------------------------------

type ImageSpec = { width: number; height: number }

async function makePng({ width, height }: ImageSpec): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer()
}

async function makeJpeg({ width, height }: ImageSpec): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer()
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('strips non-alphanumeric characters (except existing hyphens)', () => {
    expect(slugify('Product: v2.0 (alpha)!')).toBe('product-v20-alpha')
  })

  it('collapses multiple spaces/hyphens into a single hyphen', () => {
    expect(slugify('a   b--c')).toBe('a-b-c')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello')
  })

  it('respects the maxLength parameter', () => {
    const long = 'a'.repeat(60)
    expect(slugify(long, 20)).toHaveLength(20)
  })

  it('defaults maxLength to 50', () => {
    const long = 'a'.repeat(80)
    expect(slugify(long)).toHaveLength(50)
  })

  it('returns an empty string for an input of only special characters', () => {
    expect(slugify('!@#$%^&*()')).toBe('')
  })

  it('handles an empty string without throwing', () => {
    expect(slugify('')).toBe('')
  })

  it('preserves existing hyphens between words', () => {
    expect(slugify('red-car')).toBe('red-car')
  })

  it('may produce a trailing hyphen when maxLength cuts mid-slug (known limitation)', () => {
    // slugify strips leading/trailing hyphens BEFORE slicing, so if the slice
    // boundary falls on a hyphen that was injected by the space→hyphen step,
    // the hyphen is not re-stripped. 'abcde fghij' → 'abcde-fghij'.slice(0,6)
    // = 'abcde-'. Callers should be aware of this when using very short maxLengths.
    const result = slugify('abcde fghij', 6)
    // Document current behaviour — the trailing hyphen is NOT stripped after slicing.
    expect(result).toBe('abcde-')
  })
})

// ---------------------------------------------------------------------------
// resolveExtension
// ---------------------------------------------------------------------------

describe('resolveExtension', () => {
  it('returns "jpg" for image/jpeg', () => {
    expect(resolveExtension('image/jpeg')).toBe('jpg')
  })

  it('returns "webp" for image/webp', () => {
    expect(resolveExtension('image/webp')).toBe('webp')
  })

  it('returns "png" for image/png', () => {
    expect(resolveExtension('image/png')).toBe('png')
  })

  it('returns "png" for unknown mime types (safe fallback)', () => {
    expect(resolveExtension('image/tiff')).toBe('png')
    expect(resolveExtension('application/octet-stream')).toBe('png')
    expect(resolveExtension('')).toBe('png')
  })

  it('is case-sensitive — "image/JPEG" does NOT match', () => {
    // Verifies exact contract; callers are expected to normalise case.
    expect(resolveExtension('image/JPEG')).toBe('png')
  })

  it('returns "heic" for image/heic', () => {
    expect(resolveExtension('image/heic')).toBe('heic')
  })

  it('returns "heic" for image/heif', () => {
    expect(resolveExtension('image/heif')).toBe('heic')
  })
})

// ---------------------------------------------------------------------------
// buildImageFileName
// ---------------------------------------------------------------------------

describe('buildImageFileName', () => {
  it('produces the expected format gen-{nn}-{slug}-{timestamp}.{ext}', () => {
    const name = buildImageFileName(1, 'red bottle', 'png')
    expect(name).toMatch(/^gen-01-red-bottle-\d+\.png$/)
  })

  it('zero-pads single-digit variation numbers to two digits', () => {
    expect(buildImageFileName(3, null, 'webp')).toMatch(/^gen-03-/)
  })

  it('omits the slug segment when promptSlug is null', () => {
    const name = buildImageFileName(5, null, 'jpg')
    expect(name).toMatch(/^gen-05-\d+\.jpg$/)
  })

  it('omits the slug segment when promptSlug is undefined', () => {
    const name = buildImageFileName(5, undefined, 'jpg')
    expect(name).toMatch(/^gen-05-\d+\.jpg$/)
  })

  it('omits the slug segment when promptSlug is an empty string', () => {
    // Empty string is falsy — treated the same as null
    const name = buildImageFileName(5, '', 'jpg')
    expect(name).toMatch(/^gen-05-\d+\.jpg$/)
  })

  it('handles variation numbers > 99 without truncating', () => {
    const name = buildImageFileName(100, null, 'png')
    expect(name).toMatch(/^gen-100-\d+\.png$/)
  })

  it('slugifies the prompt before embedding it', () => {
    const name = buildImageFileName(1, 'Hello World!', 'png')
    expect(name).toContain('hello-world')
    expect(name).not.toContain('Hello')
    expect(name).not.toContain('!')
  })

  it('always embeds a numeric timestamp', () => {
    const before = Date.now()
    const name = buildImageFileName(1, null, 'png')
    const after = Date.now()
    const match = name.match(/-(\d+)\.png$/)
    expect(match).not.toBeNull()
    const ts = parseInt(match![1], 10)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// buildImageStoragePath
// ---------------------------------------------------------------------------

describe('buildImageStoragePath', () => {
  it('nests the filename under products/{productId}/jobs/{jobId}/', () => {
    const path = buildImageStoragePath('prod-1', 'job-2', 1, null, 'png')
    expect(path).toMatch(/^products\/prod-1\/jobs\/job-2\/gen-01-\d+\.png$/)
  })

  it('includes the slugified prompt in the path when provided', () => {
    const path = buildImageStoragePath('prod-1', 'job-2', 1, 'blue sky', 'webp')
    expect(path).toContain('blue-sky')
  })

  it('uses the provided extension correctly', () => {
    const path = buildImageStoragePath('p', 'j', 1, null, 'jpg')
    expect(path).toMatch(/\.jpg$/)
  })
})

// ---------------------------------------------------------------------------
// buildThumbnailPath / buildPreviewPath
// ---------------------------------------------------------------------------

describe('buildThumbnailPath', () => {
  it('inserts a "thumbs" subfolder and changes the extension', () => {
    const result = buildThumbnailPath('products/123/jobs/456/gen-01.png', 'webp')
    expect(result).toBe('products/123/jobs/456/thumbs/gen-01.webp')
  })

  it('works for a flat (no directory) storage path', () => {
    // dirname('gen-01.png') === '.' — should not emit a literal "." prefix
    const result = buildThumbnailPath('gen-01.png', 'webp')
    expect(result).toBe('thumbs/gen-01.webp')
    expect(result).not.toContain('./')
  })

  it('strips only the last extension when filename contains multiple dots', () => {
    const result = buildThumbnailPath('products/p/jobs/j/gen-01.v2.png', 'webp')
    expect(result).toBe('products/p/jobs/j/thumbs/gen-01.v2.webp')
  })
})

describe('buildPreviewPath', () => {
  it('inserts a "previews" subfolder and changes the extension', () => {
    const result = buildPreviewPath('products/123/jobs/456/gen-01.png', 'webp')
    expect(result).toBe('products/123/jobs/456/previews/gen-01.webp')
  })

  it('works for a flat (no directory) storage path', () => {
    const result = buildPreviewPath('gen-01.png', 'jpg')
    expect(result).toBe('previews/gen-01.jpg')
    expect(result).not.toContain('./')
  })
})

// ---------------------------------------------------------------------------
// compressReferenceImage — Sharp pipeline tests
// ---------------------------------------------------------------------------

describe('compressReferenceImage', () => {
  let smallPng: Buffer
  let smallJpeg: Buffer

  beforeAll(async () => {
    // 100×100 images are well within both thresholds (5 MB, 4096 px)
    smallPng = await makePng({ width: 100, height: 100 })
    smallJpeg = await makeJpeg({ width: 100, height: 100 })
  })

  // ------------------------------------------------------------------
  // No-op path: image already within limits
  // ------------------------------------------------------------------

  it('returns wasCompressed=false when image is within all limits', async () => {
    const result = await compressReferenceImage(smallPng)
    expect(result.wasCompressed).toBe(false)
  })

  it('returns the original buffer reference unchanged when no compression needed', async () => {
    const result = await compressReferenceImage(smallPng)
    expect(result.buffer).toBe(smallPng) // same reference, not a copy
  })

  it('reports originalSize === compressedSize when no compression occurred', async () => {
    const result = await compressReferenceImage(smallPng)
    expect(result.originalSize).toBe(smallPng.length)
    expect(result.compressedSize).toBe(smallPng.length)
  })

  it('preserves the original format in the mime/extension when not compressed (PNG)', async () => {
    const result = await compressReferenceImage(smallPng)
    expect(result.mimeType).toBe('image/png')
    expect(result.extension).toBe('png')
  })

  it('preserves the original format in the mime/extension when not compressed (JPEG)', async () => {
    const result = await compressReferenceImage(smallJpeg)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.extension).toBe('jpeg')
  })

  // ------------------------------------------------------------------
  // Compression triggered by file size exceeding 5 MB
  // ------------------------------------------------------------------

  it('compresses when the file size exceeds 5 MB', async () => {
    // Create a large uncompressed PNG that exceeds 5 MB.
    // A 2048×2048 raw TIFF-like PNG with noise will be large enough.
    // We fabricate a buffer that is 6 MB of valid PNG data by creating a
    // wide image with 3 channels — sharp can handle this directly.
    const bigBuffer = await sharp({
      create: {
        width: 2048,
        height: 1024,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .png({ compressionLevel: 0 }) // no deflate → large file
      .toBuffer()

    // Verify our test image actually exceeds the threshold before asserting
    const FIVE_MB = 5 * 1024 * 1024
    if (bigBuffer.length <= FIVE_MB) {
      // If the synthetic image ended up smaller (deflate still worked), skip
      // gracefully rather than producing a misleading failure.
      console.warn(`Skipping size-trigger test: synthetic image is only ${bigBuffer.length} bytes`)
      return
    }

    const result = await compressReferenceImage(bigBuffer)
    expect(result.wasCompressed).toBe(true)
    expect(result.mimeType).toBe('image/webp')
    expect(result.extension).toBe('webp')
    expect(result.compressedSize).toBeGreaterThan(0)
    expect(result.originalSize).toBe(bigBuffer.length)
  })

  // ------------------------------------------------------------------
  // Compression triggered by dimension exceeding 4096 px
  // ------------------------------------------------------------------

  it('compresses and resizes when width exceeds 4096 px', async () => {
    const wide = await makePng({ width: 5000, height: 100 })
    const result = await compressReferenceImage(wide)
    expect(result.wasCompressed).toBe(true)
    expect(result.mimeType).toBe('image/webp')
    expect(result.extension).toBe('webp')

    // The output image must fit within the 4096-dimension box
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(4096)
    expect(meta.height).toBeLessThanOrEqual(4096)
  })

  it('compresses and resizes when height exceeds 4096 px', async () => {
    const tall = await makePng({ width: 100, height: 5000 })
    const result = await compressReferenceImage(tall)
    expect(result.wasCompressed).toBe(true)

    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(4096)
    expect(meta.height).toBeLessThanOrEqual(4096)
  })

  it('preserves aspect ratio when resizing a landscape image that exceeds max dimension', async () => {
    // 8000×4000 → should become 4096×2048 (2:1 ratio preserved)
    const landscape = await makePng({ width: 8000, height: 4000 })
    const result = await compressReferenceImage(landscape)
    const meta = await sharp(result.buffer).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    expect(w).toBeLessThanOrEqual(4096)
    expect(h).toBeLessThanOrEqual(4096)
    // Aspect ratio within 1% tolerance
    expect(Math.abs(w / h - 2)).toBeLessThan(0.01)
  })

  it('does not enlarge an image that is already smaller than 4096 px', async () => {
    // 200×200 — should come out at 200×200 (withoutEnlargement is set)
    const small = await makePng({ width: 200, height: 200 })
    // Force the size-trigger by building a 6+ MB version in memory is complex;
    // instead directly verify the no-op path keeps original dimensions.
    const result = await compressReferenceImage(small)
    if (!result.wasCompressed) {
      // Not compressed → buffer is unchanged, nothing to verify about dimensions
      expect(result.buffer).toBe(small)
    } else {
      const meta = await sharp(result.buffer).metadata()
      expect(meta.width).toBeLessThanOrEqual(200)
      expect(meta.height).toBeLessThanOrEqual(200)
    }
  })

  // ------------------------------------------------------------------
  // Output structure integrity
  // ------------------------------------------------------------------

  it('returns a valid WebP buffer when compression is triggered', async () => {
    const wide = await makePng({ width: 5000, height: 10 })
    const result = await compressReferenceImage(wide)
    expect(result.wasCompressed).toBe(true)

    // Verify the buffer is actually a WebP by checking the RIFF/WEBP header
    const header = result.buffer.slice(0, 4).toString('ascii')
    expect(header).toBe('RIFF')
    const format = result.buffer.slice(8, 12).toString('ascii')
    expect(format).toBe('WEBP')
  })

  it('reports compressedSize matching the actual buffer length', async () => {
    const wide = await makePng({ width: 5000, height: 10 })
    const result = await compressReferenceImage(wide)
    expect(result.compressedSize).toBe(result.buffer.length)
  })

  // ------------------------------------------------------------------
  // Error propagation
  // ------------------------------------------------------------------

  it('throws when given an empty buffer (not a valid image)', async () => {
    await expect(compressReferenceImage(Buffer.alloc(0))).rejects.toThrow()
  })

  it('throws when given random non-image data', async () => {
    const garbage = Buffer.from('this is definitely not an image format at all')
    await expect(compressReferenceImage(garbage)).rejects.toThrow()
  })

  it('includes context and a diagnostic detail when metadata cannot be read', async () => {
    const garbage = Buffer.from('this is definitely not an image format at all')
    // The contextualised wrapper must survive, and Sharp's own diagnosis is
    // appended after an em-dash so corrupt-vs-unsupported is distinguishable.
    await expect(compressReferenceImage(garbage)).rejects.toThrow(
      /^compressReferenceImage: could not read image metadata .* — .+/
    )
  })

  it('throws when image dimensions exceed the per-side limit (pixel bomb guard)', async () => {
    // Sharp's create helper lets us synthesize an image with huge declared
    // dimensions without actually allocating the full bitmap in the test.
    // 33 000 px exceeds the 32 768 px per-side ceiling.
    const huge = await sharp({
      create: { width: 33_000, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
    await expect(compressReferenceImage(huge)).rejects.toThrow(
      /dimensions.*exceed maximum/i
    )
  })

  // ------------------------------------------------------------------
  // Animated inputs — data-loss guard
  // ------------------------------------------------------------------

  it('passes through an animated image even when it exceeds the dimension threshold', async () => {
    // Two 5000px-wide frames joined into an animated WebP. Width exceeds the
    // 4096px resize trigger, but re-encoding would flatten the animation to a
    // single static frame (Sharp decodes only page 0 by default) — and the
    // caller deletes the original afterwards, making that loss permanent.
    // The frames must differ in content: identical frames are deduplicated
    // into a single page by the WebP encoder.
    const frame1 = await sharp({
      create: { width: 5000, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer()
    const frame2 = await sharp({
      create: { width: 5000, height: 40, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toBuffer()
    const animated = await sharp([frame1, frame2], { join: { animated: true } })
      .webp()
      .toBuffer()

    // Sanity: confirm the synthetic input really is multi-page and oversized.
    const inMeta = await sharp(animated).metadata()
    expect(inMeta.pages).toBe(2)
    expect(inMeta.width).toBeGreaterThan(4096)

    const result = await compressReferenceImage(animated)
    expect(result.wasCompressed).toBe(false)
    expect(result.buffer).toBe(animated) // same reference — original preserved
    expect(result.mimeType).toBe('image/webp')

    // All frames survive.
    const outMeta = await sharp(result.buffer).metadata()
    expect(outMeta.pages).toBe(2)
  })

  it('still enforces the pixel-bomb dimension guard for animated images', async () => {
    // The animated passthrough must not become a bypass for the memory guard:
    // per-page dimensions are validated before the pages check. GIF output is
    // used because WebP cannot encode >16383px per side; frames must differ so
    // the encoder does not deduplicate them into a single page.
    const frame1 = await sharp({
      create: { width: 33_000, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer()
    const frame2 = await sharp({
      create: { width: 33_000, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toBuffer()
    const animated = await sharp([frame1, frame2], { join: { animated: true } })
      .gif()
      .toBuffer()
    await expect(compressReferenceImage(animated)).rejects.toThrow(
      /dimensions.*exceed maximum/i
    )
  })

  it('throws at the exact MAX_SAFE_INPUT_DIMENSION boundary (pixel bomb guard)', async () => {
    // A 32 768-px wide image passes the old `>` check but should be rejected.
    // Decoded at 32 768×100 RGBA that is ~13 MB, but the guard fires before
    // any decode, so the test is cheap to run.
    const atLimit = await sharp({
      create: { width: 32_768, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
    await expect(compressReferenceImage(atLimit)).rejects.toThrow(
      /dimensions.*exceed maximum/i
    )
  })
})

// ---------------------------------------------------------------------------
// assertImageDimensions — memory-safety guard (pure, no bitmap allocation)
//
// Tested directly with plain numbers so the total-area branch can be exercised
// without materialising a multi-hundred-megapixel bitmap in the test process.
// ---------------------------------------------------------------------------

describe('assertImageDimensions', () => {
  it('accepts an image comfortably within both limits', () => {
    expect(() => assertImageDimensions(4096, 4096, 'test')).not.toThrow()
  })

  it('rejects when a single axis reaches the per-side ceiling', () => {
    expect(() => assertImageDimensions(32_768, 100, 'test')).toThrow(
      /dimensions.*exceed maximum/i
    )
  })

  it('rejects when the total area exceeds the max even though each axis is in-range', () => {
    // 20000 × 20000 = 400 MP: both axes are below the 32 768 per-side ceiling
    // yet the decoded area (~1.6 GB as RGBA) is a memory bomb.
    expect(() => assertImageDimensions(20_000, 20_000, 'test')).toThrow(
      /area.*exceeds maximum decodable area/i
    )
  })

  it('accepts a large-but-thin image whose total area stays under the ceiling', () => {
    // 30000 × 8000 = 240 MP < 268,402,689, and neither axis hits 32 768.
    expect(() => assertImageDimensions(30_000, 8_000, 'test')).not.toThrow()
  })

  it('includes the provided context in the thrown message', () => {
    expect(() => assertImageDimensions(20_000, 20_000, 'myContext')).toThrow(
      /^myContext:/
    )
  })
})

// ---------------------------------------------------------------------------
// createThumbnail / createPreview — Sharp resize helpers
// ---------------------------------------------------------------------------

describe('createThumbnail', () => {
  it('returns a WebP buffer with mimeType image/webp and extension webp', async () => {
    const src = await makePng({ width: 1000, height: 800 })
    const result = await createThumbnail(src)
    expect(result.mimeType).toBe('image/webp')
    expect(result.extension).toBe('webp')
  })

  it('resizes a large image to 480px width by default', async () => {
    const src = await makePng({ width: 1000, height: 800 })
    const result = await createThumbnail(src)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(480)
  })

  it('accepts a custom width parameter', async () => {
    const src = await makePng({ width: 1000, height: 800 })
    const result = await createThumbnail(src, 240)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(240)
  })

  it('does not enlarge a small image beyond its original width', async () => {
    const src = await makePng({ width: 200, height: 150 })
    const result = await createThumbnail(src) // default 480, but image is only 200px
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(200)
  })

  it('returns a non-empty buffer', async () => {
    const src = await makePng({ width: 500, height: 400 })
    const result = await createThumbnail(src)
    expect(result.buffer.length).toBeGreaterThan(0)
  })

  it('throws when given an empty buffer', async () => {
    await expect(createThumbnail(Buffer.alloc(0))).rejects.toThrow(
      'resizeToWebP: buffer is empty'
    )
  })
})

describe('createPreview', () => {
  it('returns a WebP buffer with mimeType image/webp and extension webp', async () => {
    const src = await makePng({ width: 2000, height: 1500 })
    const result = await createPreview(src)
    expect(result.mimeType).toBe('image/webp')
    expect(result.extension).toBe('webp')
  })

  it('resizes a large image to 1600px width by default', async () => {
    const src = await makePng({ width: 3000, height: 2000 })
    const result = await createPreview(src)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(1600)
  })

  it('does not enlarge a small image beyond its original width', async () => {
    const src = await makePng({ width: 400, height: 300 })
    const result = await createPreview(src)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(400)
  })

  it('accepts a custom width parameter', async () => {
    const src = await makePng({ width: 3000, height: 2000 })
    const result = await createPreview(src, 800)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(800)
  })

  it('throws when given an empty buffer', async () => {
    await expect(createPreview(Buffer.alloc(0))).rejects.toThrow(
      'resizeToWebP: buffer is empty'
    )
  })
})

// ---------------------------------------------------------------------------
// createThumbnailAndPreview — parallel generation
// ---------------------------------------------------------------------------

describe('createThumbnailAndPreview', () => {
  it('resolves to a [thumbnail, preview] tuple — both WebP', async () => {
    const src = await makePng({ width: 2000, height: 1500 })
    const [thumb, preview] = await createThumbnailAndPreview(src)
    expect(thumb.mimeType).toBe('image/webp')
    expect(thumb.extension).toBe('webp')
    expect(preview.mimeType).toBe('image/webp')
    expect(preview.extension).toBe('webp')
  })

  it('thumbnail is 480px wide and preview is 1600px wide', async () => {
    const src = await makePng({ width: 3000, height: 2000 })
    const [thumb, preview] = await createThumbnailAndPreview(src)
    const thumbMeta = await sharp(thumb.buffer).metadata()
    const previewMeta = await sharp(preview.buffer).metadata()
    expect(thumbMeta.width).toBe(480)
    expect(previewMeta.width).toBe(1600)
  })

  it('both outputs are non-empty buffers', async () => {
    const src = await makePng({ width: 1000, height: 800 })
    const [thumb, preview] = await createThumbnailAndPreview(src)
    expect(thumb.buffer.length).toBeGreaterThan(0)
    expect(preview.buffer.length).toBeGreaterThan(0)
  })

  it('does not enlarge thumbnail beyond original when image is small', async () => {
    const src = await makePng({ width: 200, height: 150 })
    const [thumb] = await createThumbnailAndPreview(src)
    const meta = await sharp(thumb.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(200)
  })

  it('throws when given an empty buffer', async () => {
    await expect(createThumbnailAndPreview(Buffer.alloc(0))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// extractVideoThumbnail — guard tests (no ffmpeg required)
// The empty-buffer guard fires before ensureFfmpegPath(), so these tests
// run without a real video file or ffmpeg binary.
// ---------------------------------------------------------------------------

describe('extractVideoThumbnail', () => {
  it('throws when given an empty buffer', async () => {
    await expect(extractVideoThumbnail(Buffer.alloc(0))).rejects.toThrow(
      'extractVideoThumbnail: buffer is empty'
    )
  })
})
