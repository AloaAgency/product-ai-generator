/**
 * Shared utilities for product image generation
 */

import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import { randomUUID } from 'crypto'
import { writeFile, readFile, unlink, access } from 'fs/promises'
import { logger } from '@/lib/logger'

// Resolve ffmpeg path: try ffmpeg-static first (checking the file exists),
// then fall back to system ffmpeg
async function resolveFfmpegPath(): Promise<string | null> {
  try {
    // ffmpeg-static path can be mangled by bundlers, so verify it exists.
    // require() is intentional here — dynamic loading so a missing optional
    // dependency is caught at runtime rather than at module parse time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static') as string
    if (ffmpegStatic) {
      await access(ffmpegStatic)
      return ffmpegStatic
    }
  } catch { /* not available or path mangled */ }
  try {
    const systemPath = execSync('which ffmpeg', { encoding: 'utf-8' }).trim()
    if (systemPath) return systemPath
  } catch { /* no system ffmpeg */ }
  return null
}

// Cache the resolution promise so concurrent callers share the same in-flight
// work rather than racing to call setFfmpegPath multiple times.
// The promise is cleared on failure so subsequent calls can retry (e.g. if
// ffmpeg is installed after the server starts).
let ffmpegPathPromise: Promise<void> | null = null
function ensureFfmpegPath(): Promise<void> {
  if (!ffmpegPathPromise) {
    ffmpegPathPromise = resolveFfmpegPath()
      .then((p) => {
        if (!p) {
          throw new Error(
            'ffmpeg not found: install the ffmpeg-static package or ensure ffmpeg is on PATH'
          )
        }
        ffmpeg.setFfmpegPath(p)
      })
      .catch((err) => {
        // Reset on any failure so subsequent calls can retry rather than
        // receiving a permanently cached rejection.
        ffmpegPathPromise = null
        throw err
      })
  }
  return ffmpegPathPromise
}

/**
 * Slugify a string for use in filenames
 */
export const slugify = (text: string, maxLength = 50): string => {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
}

/**
 * Resolve file extension from mime type
 */
export const resolveExtension = (mimeType: string): string => {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return 'heic'
  return 'png'
}

/**
 * Build a descriptive filename for generated product images
 * Format: product-{variation:02d}-{slugified-prompt}-{timestamp}.{ext}
 */
export const buildImageFileName = (
  variationNumber: number,
  promptSlug: string | null | undefined,
  extension: string
): string => {
  const numPadded = String(variationNumber).padStart(2, '0')
  const slug = promptSlug ? `-${slugify(promptSlug)}` : ''
  const timestamp = Date.now()
  return `gen-${numPadded}${slug}-${timestamp}.${extension}`
}

/**
 * Build storage path for generated product images
 */
export const buildImageStoragePath = (
  productId: string,
  jobId: string,
  variationNumber: number,
  promptSlug: string | null | undefined,
  extension: string
): string => {
  const fileName = buildImageFileName(variationNumber, promptSlug, extension)
  return `products/${productId}/jobs/${jobId}/${fileName}`
}

/**
 * Build a sibling-folder path for derived assets (e.g. thumbnails, previews).
 * Given `products/123/jobs/456/gen-01.png` and subfolder `thumbs`, returns
 * `products/123/jobs/456/thumbs/gen-01.webp`.
 */
const buildDerivedPath = (storagePath: string, subfolder: string, extension: string): string => {
  const dir = dirname(storagePath)
  const baseName = basename(storagePath).replace(/\.[^/.]+$/, '')
  const fileName = `${baseName}.${extension}`
  return dir === '.' ? `${subfolder}/${fileName}` : `${dir}/${subfolder}/${fileName}`
}

/**
 * Build thumbnail storage path
 */
export const buildThumbnailPath = (storagePath: string, extension: string): string =>
  buildDerivedPath(storagePath, 'thumbs', extension)

/**
 * Build preview storage path
 */
export const buildPreviewPath = (storagePath: string, extension: string): string =>
  buildDerivedPath(storagePath, 'previews', extension)

// Hard ceiling applied before any Sharp pipeline runs. Prevents memory
// exhaustion if upstream size limits (e.g. multipart validation) are bypassed.
const MAX_BUFFER_BYTES = 100 * 1024 * 1024 // 100 MB

// Decoded-dimension guard for user-supplied images. A file that is small on
// disk but claims huge pixel dimensions (a "pixel bomb") would pass the buffer
// size check yet still exhaust memory during decode. We cap each axis at 32 k
// pixels (≈8× the max output dimension) before any Sharp pipeline executes.
const MAX_SAFE_INPUT_DIMENSION = 32_768

// Total decoded-area guard. The per-axis ceiling alone permits an image where
// neither side exceeds MAX_SAFE_INPUT_DIMENSION yet the product is enormous
// (e.g. 20000×20000 ≈ 400 MP ≈ 1.6 GB once decoded to RGBA). Sharp would reject
// such a file at decode time via its own limitInputPixels default, but only
// after this module has already read metadata — and the failure surfaces as a
// generic downstream "Sharp encode failed". We cap the total at Sharp's own
// default (0x3FFF² = 268,402,689) so nothing Sharp would have accepted is newly
// rejected; we simply fail earlier, before any decode, with a clear message.
const MAX_SAFE_INPUT_PIXELS = 268_402_689 // 0x3FFF² — matches Sharp's default limitInputPixels

function assertBufferSize(buffer: Buffer, context: string): void {
  if (buffer.length === 0) throw new Error(`${context}: buffer is empty`)
  if (buffer.length > MAX_BUFFER_BYTES) {
    throw new Error(
      `${context}: buffer exceeds maximum size limit (${MAX_BUFFER_BYTES / 1024 / 1024} MB)`
    )
  }
}

// Shared dimension assertion used by assertInputDimensions and
// compressReferenceImage (which already has metadata in hand). Keeping a
// single implementation prevents the two call-sites from diverging if the
// threshold changes. Exported so the guard can be unit-tested with plain
// numbers, without materialising a multi-hundred-megapixel bitmap in memory.
export function assertImageDimensions(w: number, h: number, context: string): void {
  if (w >= MAX_SAFE_INPUT_DIMENSION || h >= MAX_SAFE_INPUT_DIMENSION) {
    throw new Error(
      `${context}: image dimensions ${w}x${h} exceed maximum allowed (${MAX_SAFE_INPUT_DIMENSION}px per side)`
    )
  }
  // Guard the total decoded area even when each axis is individually in-range.
  if (w * h > MAX_SAFE_INPUT_PIXELS) {
    throw new Error(
      `${context}: image area ${w}x${h} (${w * h}px) exceeds maximum decodable area (${MAX_SAFE_INPUT_PIXELS}px)`
    )
  }
}

// Reads only the image header (fast) to guard against pixel bombs: files whose
// compressed size passes the buffer check but whose decoded dimensions would
// exhaust available memory. Must be called before any Sharp decode pipeline.
async function assertInputDimensions(buffer: Buffer, context: string): Promise<void> {
  let meta: sharp.Metadata
  try {
    meta = await sharp(buffer).metadata()
  } catch {
    throw new Error(`${context}: could not read image metadata (file may be corrupt or unsupported)`)
  }
  assertImageDimensions(meta.width ?? 0, meta.height ?? 0, context)
}

/** Shared return shape for all Sharp encode operations. */
export type ImageResult = { buffer: Buffer; mimeType: string; extension: string }

const THUMB_WIDTH = 480
const THUMB_QUALITY = 72
const PREVIEW_WIDTH = 1600
const PREVIEW_QUALITY = 82

// Encode-only Sharp pipeline. Callers MUST run assertBufferSize +
// assertInputDimensions on the source first — this is split out so functions
// producing multiple outputs from one buffer can validate it once instead of
// paying a metadata decode per output.
async function encodeWebP(
  buffer: Buffer,
  width: number,
  quality: number,
  context: string
): Promise<ImageResult> {
  let outBuffer: Buffer
  try {
    outBuffer = await sharp(buffer)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()
  } catch (err) {
    throw new Error(
      `${context}: Sharp encode failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (outBuffer.length === 0) {
    throw new Error(`${context}: Sharp encode produced empty buffer`)
  }
  return { buffer: outBuffer, mimeType: 'image/webp', extension: 'webp' }
}

/** Resize an image buffer to a WebP of the given width and quality. */
async function resizeToWebP(buffer: Buffer, width: number, quality: number): Promise<ImageResult> {
  assertBufferSize(buffer, 'resizeToWebP')
  await assertInputDimensions(buffer, 'resizeToWebP')
  return encodeWebP(buffer, width, quality, 'resizeToWebP')
}

/**
 * Generate a resized thumbnail buffer (480px WebP)
 */
export const createThumbnail = (buffer: Buffer, width = THUMB_WIDTH): Promise<ImageResult> =>
  resizeToWebP(buffer, width, THUMB_QUALITY)

/**
 * Generate a resized preview buffer (1600px WebP)
 */
export const createPreview = (buffer: Buffer, width = PREVIEW_WIDTH): Promise<ImageResult> =>
  resizeToWebP(buffer, width, PREVIEW_QUALITY)

/**
 * Generate thumbnail and preview in parallel from the same source buffer.
 * Validates the shared source once (one metadata decode instead of two),
 * then runs both encodes concurrently.
 */
export const createThumbnailAndPreview = async (
  buffer: Buffer
): Promise<[ImageResult, ImageResult]> => {
  assertBufferSize(buffer, 'createThumbnailAndPreview')
  await assertInputDimensions(buffer, 'createThumbnailAndPreview')
  return Promise.all([
    encodeWebP(buffer, THUMB_WIDTH, THUMB_QUALITY, 'createThumbnailAndPreview'),
    encodeWebP(buffer, PREVIEW_WIDTH, PREVIEW_QUALITY, 'createThumbnailAndPreview'),
  ])
}

/** Thresholds for reference image compression */
const REF_MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const REF_MAX_DIMENSION = 4096             // px

// Raster formats accepted as reference images. SVG and jp2 are excluded:
// SVG is an XML format Sharp parses via librsvg (larger attack surface),
// and jp2/raw are not valid user-upload targets for this app.
const ALLOWED_REF_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff', 'heif'])

// Explicit whitelist from Sharp format identifiers to IANA MIME types.
// Avoids interpolating an external string directly into a MIME type header.
const FORMAT_MIME_MAP: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  tiff: 'image/tiff',
  heif: 'image/heif',
}

export type CompressResult = {
  buffer: Buffer
  mimeType: string
  extension: string
  originalSize: number
  compressedSize: number
  wasCompressed: boolean
}

/**
 * Compress a reference image if it exceeds size/dimension thresholds.
 * Returns the original buffer unchanged when already within limits.
 */
export const compressReferenceImage = async (buffer: Buffer): Promise<CompressResult> => {
  assertBufferSize(buffer, 'compressReferenceImage')
  const originalSize = buffer.length
  let meta: sharp.Metadata
  try {
    meta = await sharp(buffer).metadata()
  } catch {
    throw new Error('compressReferenceImage: could not read image metadata (file may be corrupt or unsupported)')
  }
  if (!meta.format || !ALLOWED_REF_FORMATS.has(meta.format)) {
    throw new Error(`compressReferenceImage: unsupported format '${meta.format ?? 'unknown'}'`)
  }
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  assertImageDimensions(w, h, 'compressReferenceImage')

  const needsResize = w > REF_MAX_DIMENSION || h > REF_MAX_DIMENSION
  const needsCompress = originalSize > REF_MAX_FILE_SIZE

  if (!needsResize && !needsCompress) {
    return {
      buffer,
      mimeType: (meta.format && FORMAT_MIME_MAP[meta.format]) ?? 'application/octet-stream',
      extension: meta.format ?? 'bin',
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
    }
  }

  // Always rotate first to honour EXIF orientation before any resize operation.
  const pipeline = sharp(buffer).rotate()
  if (needsResize) {
    pipeline.resize({ width: REF_MAX_DIMENSION, height: REF_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
  }
  let compressed: Buffer
  try {
    compressed = await pipeline.webp({ quality: 90 }).toBuffer()
  } catch (err) {
    throw new Error(
      `compressReferenceImage: Sharp encode failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (compressed.length === 0) {
    throw new Error('compressReferenceImage: Sharp encode produced empty buffer')
  }

  // Only replace the original when the output is actually smaller. Re-encoding
  // an already-optimised file (e.g. a small PNG or a high-quality WebP) can
  // produce a larger output, which would inflate storage and trigger a needless
  // DB update without any benefit.
  if (compressed.length >= originalSize) {
    return {
      buffer,
      mimeType: (meta.format && FORMAT_MIME_MAP[meta.format]) ?? 'application/octet-stream',
      extension: meta.format ?? 'bin',
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
    }
  }

  return {
    buffer: compressed,
    mimeType: 'image/webp',
    extension: 'webp',
    originalSize,
    compressedSize: compressed.length,
    wasCompressed: true,
  }
}

function runFfmpegExtract(inputPath: string, outputPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ff = ffmpeg(inputPath)
      .seekInput(0.1)
      .frames(1)
      .outputOptions('-update', '1')
      .output(outputPath)
    const timer = setTimeout(() => {
      ff.kill('SIGKILL')
      reject(new Error('extractVideoThumbnail: timed out after 30s'))
    }, 30_000)
    ff.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', (err: Error) => { clearTimeout(timer); reject(err) })
      .run()
  })
}

/**
 * Extract the first frame from a video buffer and create a 480px WebP thumbnail.
 * Uses ffmpeg-static to extract the frame, then sharp to resize and convert.
 */
export const extractVideoThumbnail = async (
  videoBuffer: Buffer,
  width = 480
): Promise<ImageResult> => {
  assertBufferSize(videoBuffer, 'extractVideoThumbnail')

  await ensureFfmpegPath()

  const id = randomUUID()
  const tmpVideo = join(tmpdir(), `vid-${id}.mp4`)
  const tmpFrame = join(tmpdir(), `frame-${id}.png`)

  try {
    try {
      await writeFile(tmpVideo, videoBuffer)
    } catch (err) {
      throw new Error(
        `extractVideoThumbnail: failed to stage temp video — ${err instanceof Error ? err.message : String(err)}`
      )
    }

    await runFfmpegExtract(tmpVideo, tmpFrame)

    // ffmpeg can exit 0 yet leave no frame on disk (e.g. a seek past the end of
    // a truncated clip). Surface that as a clear "no output frame" error rather
    // than letting a raw ENOENT from readFile bubble up.
    let frameBuffer: Buffer
    try {
      frameBuffer = await readFile(tmpFrame)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      throw new Error(
        code === 'ENOENT'
          ? 'extractVideoThumbnail: ffmpeg produced no output frame'
          : `extractVideoThumbnail: failed to read extracted frame — ${err instanceof Error ? err.message : String(err)}`
      )
    }

    assertBufferSize(frameBuffer, 'extractVideoThumbnail:frame')
    await assertInputDimensions(frameBuffer, 'extractVideoThumbnail:frame')
    return await encodeWebP(frameBuffer, width, THUMB_QUALITY, 'extractVideoThumbnail')
  } finally {
    // Best-effort temp cleanup. A missing file (ENOENT) is expected when the
    // frame was never written (e.g. ffmpeg failed before producing output), so
    // we ignore it; any other failure leaks a file in /tmp and is worth a warn.
    await Promise.all([
      unlink(tmpVideo).catch(reportTempCleanupFailure),
      unlink(tmpFrame).catch(reportTempCleanupFailure),
    ])
  }
}

function reportTempCleanupFailure(err: NodeJS.ErrnoException): void {
  if (err?.code === 'ENOENT') return
  logger.warn('extractVideoThumbnail: failed to remove temp file:', err)
}
