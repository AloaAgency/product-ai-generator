/**
 * Shared utilities for product image generation
 */

import sharp from 'sharp'

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
 * Build thumbnail storage path
 */
export const buildThumbnailPath = (storagePath: string, extension: string): string => {
  const lastSlash = storagePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash)
  const fileName = lastSlash === -1 ? storagePath : storagePath.slice(lastSlash + 1)
  const baseName = fileName.replace(/\.[^/.]+$/, '')
  const suffix = `${baseName}.${extension}`
  return dir ? `${dir}/thumbs/${suffix}` : `thumbs/${suffix}`
}

/**
 * Build preview storage path
 */
export const buildPreviewPath = (storagePath: string, extension: string): string => {
  const lastSlash = storagePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash)
  const fileName = lastSlash === -1 ? storagePath : storagePath.slice(lastSlash + 1)
  const baseName = fileName.replace(/\.[^/.]+$/, '')
  const suffix = `${baseName}.${extension}`
  return dir ? `${dir}/previews/${suffix}` : `previews/${suffix}`
}

/**
 * Generate a resized thumbnail buffer (480px WebP)
 */
export const createThumbnail = async (
  buffer: Buffer,
  width = 480
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => {
  const pipeline = sharp(buffer).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 })
  return { buffer: await pipeline.toBuffer(), mimeType: 'image/webp', extension: 'webp' }
}

/**
 * Generate a resized preview buffer (1600px WebP)
 */
export const createPreview = async (
  buffer: Buffer,
  width = 1600
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => {
  const pipeline = sharp(buffer).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82 })
  return { buffer: await pipeline.toBuffer(), mimeType: 'image/webp', extension: 'webp' }
}

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

  let pipeline = sharp(buffer).rotate()
  if (needsResize) {
    pipeline = pipeline.resize({
      width: REF_MAX_DIMENSION,
      height: REF_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  const compressed = await pipeline.webp({ quality: 90 }).toBuffer()

  return {
    buffer: compressed,
    mimeType: 'image/webp',
    extension: 'webp',
    originalSize,
    compressedSize: compressed.length,
    wasCompressed: true,
  }
}
