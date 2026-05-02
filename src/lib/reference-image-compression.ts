import { createServiceClient } from '@/lib/supabase/server'
import { compressReferenceImage, CompressResult } from '@/lib/image-utils'
import { T } from '@/lib/db-tables'

const BUCKET = 'reference-images'

export type CompressionResult =
  | {
      imageId: string
      wasCompressed: false
      originalSize: number
      compressedSize: number
      newStoragePath?: undefined
      error?: string
    }
  | {
      imageId: string
      wasCompressed: true
      originalSize: number
      compressedSize: number
      newStoragePath: string
      error?: string
    }

/**
 * Download a reference image from Supabase, compress if needed,
 * re-upload (with .webp extension), and update the DB record.
 */
export async function processReferenceImageCompression(
  imageId: string,
  storagePath: string
): Promise<CompressionResult> {
  const supabase = createServiceClient()

  // Download the original file
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(storagePath)

  if (downloadError || !fileData) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: 0,
      compressedSize: 0,
      error: 'Download failed',
    }
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(await fileData.arrayBuffer())
  } catch {
    return {
      imageId,
      wasCompressed: false,
      originalSize: 0,
      compressedSize: 0,
      error: 'Buffer conversion failed',
    }
  }

  let result: CompressResult
  try {
    result = await compressReferenceImage(buffer)
  } catch {
    return {
      imageId,
      wasCompressed: false,
      originalSize: buffer.length,
      compressedSize: buffer.length,
      error: 'Compression failed',
    }
  }

  if (!result.wasCompressed) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
    }
  }

  // Build new storage path with .webp extension
  const newStoragePath = storagePath.replace(/\.[^/.]+$/, '.webp')

  // Upload the compressed version
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(newStoragePath, result.buffer, {
      contentType: result.mimeType,
      upsert: true,
    })

  if (uploadError) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      error: 'Upload failed',
    }
  }

  // Update DB record before deleting the old file so a delete failure
  // never leaves the DB pointing at a path that no longer exists.
  const { error: dbError } = await supabase
    .from(T.reference_images)
    .update({
      storage_path: newStoragePath,
      mime_type: result.mimeType,
      file_size: result.compressedSize,
    })
    .eq('id', imageId)

  if (dbError) {
    return {
      imageId,
      wasCompressed: true,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      newStoragePath,
      error: 'DB update failed',
    }
  }

  // Best-effort cleanup: remove old file if the extension changed.
  // A failure here only orphans a file in storage — the DB is already correct.
  if (newStoragePath !== storagePath) {
    await supabase.storage.from(BUCKET).remove([storagePath])
  }

  return {
    imageId,
    wasCompressed: true,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
    newStoragePath,
  }
}
