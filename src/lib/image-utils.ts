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

/** Resize an image buffer to a WebP of the given width and quality. */
async function resizeToWebP(
  buffer: Buffer,
  width: number,
  quality: number
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  if (buffer.length === 0) {
    throw new Error('resizeToWebP: buffer is empty')
  }
  const outBuffer = await sharp(buffer)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality })
    .toBuffer()
  return { buffer: outBuffer, mimeType: 'image/webp', extension: 'webp' }
}

/**
 * Generate a resized thumbnail buffer (480px WebP)
 */
export const createThumbnail = (
  buffer: Buffer,
  width = 480
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => resizeToWebP(buffer, width, 72)

/**
 * Generate a resized preview buffer (1600px WebP)
 */
export const createPreview = (
  buffer: Buffer,
  width = 1600
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => resizeToWebP(buffer, width, 82)

/**
 * Generate thumbnail and preview in parallel from the same source buffer.
 * Equivalent to calling createThumbnail + createPreview concurrently —
 * cuts Sharp processing time roughly in half vs sequential calls.
 */
export const createThumbnailAndPreview = (
  buffer: Buffer
): Promise<[
  { buffer: Buffer; mimeType: string; extension: string },
  { buffer: Buffer; mimeType: string; extension: string }
]> => Promise.all([createThumbnail(buffer), createPreview(buffer)])

/** Thresholds for reference image compression */
const REF_MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const REF_MAX_DIMENSION = 4096             // px

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
  if (buffer.length === 0) {
    throw new Error('compressReferenceImage: buffer is empty')
  }
  const originalSize = buffer.length
  const meta = await sharp(buffer).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0

  const needsResize = w > REF_MAX_DIMENSION || h > REF_MAX_DIMENSION
  const needsCompress = originalSize > REF_MAX_FILE_SIZE

  if (!needsResize && !needsCompress) {
    return {
      buffer,
      mimeType: meta.format ? `image/${meta.format}` : 'application/octet-stream',
      extension: meta.format ?? 'bin',
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
    }
  }

  // Build the Sharp pipeline step-by-step so each transformation is explicit.
  // Always rotate first to honour EXIF orientation before any resize operation.
  const base = sharp(buffer).rotate()
  const resized = needsResize
    ? base.resize({ width: REF_MAX_DIMENSION, height: REF_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    : base
  const compressed = await resized.webp({ quality: 90 }).toBuffer()

  return {
    buffer: compressed,
    mimeType: 'image/webp',
    extension: 'webp',
    originalSize,
    compressedSize: compressed.length,
    wasCompressed: true,
  }
}

/**
 * Extract the first frame from a video buffer and create a 480px WebP thumbnail.
 * Uses ffmpeg-static to extract the frame, then sharp to resize and convert.
 */
export const extractVideoThumbnail = async (
  videoBuffer: Buffer,
  width = 480
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => {
  if (videoBuffer.length === 0) {
    throw new Error('extractVideoThumbnail: video buffer is empty')
  }

  await ensureFfmpegPath()

  const id = randomUUID()
  const tmpVideo = join(tmpdir(), `vid-${id}.mp4`)
  const tmpFrame = join(tmpdir(), `frame-${id}.png`)

  try {
    await writeFile(tmpVideo, videoBuffer)

    await new Promise<void>((resolve, reject) => {
      const ff = ffmpeg(tmpVideo)
        .seekInput(0.1)
        .frames(1)
        .outputOptions('-update', '1')
        .output(tmpFrame)
      const timer = setTimeout(() => {
        ff.kill('SIGKILL')
        reject(new Error('extractVideoThumbnail: timed out after 30s'))
      }, 30_000)
      ff.on('end', () => { clearTimeout(timer); resolve() })
        .on('error', (err: Error) => { clearTimeout(timer); reject(err) })
        .run()
    })

    const frameBuffer = await readFile(tmpFrame)
    const thumb = await sharp(frameBuffer)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()

    return { buffer: thumb, mimeType: 'image/webp', extension: 'webp' }
  } finally {
    await unlink(tmpVideo).catch(() => {})
    await unlink(tmpFrame).catch(() => {})
  }
}
