import { createServiceClient } from '@/lib/supabase/server'
import { compressReferenceImage } from '@/lib/image-utils'
import { T } from '@/lib/db-tables'

const BUCKET = 'reference-images'

export type CompressionResult = {
  imageId: string
  wasCompressed: boolean
  originalSize: number
  compressedSize: number
  newStoragePath?: string
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
      error: `Download failed: ${downloadError?.message ?? 'no data'}`,
    }
  }

  const buffer = Buffer.from(await fileData.arrayBuffer())
  const result = await compressReferenceImage(buffer)

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
      error: `Upload failed: ${uploadError.message}`,
    }
  }

  // Delete old file if the path changed (different extension)
  if (newStoragePath !== storagePath) {
    await supabase.storage.from(BUCKET).remove([storagePath])
  }

  // Update DB record
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
      error: `DB update failed: ${dbError.message}`,
    }
  }

  return {
    imageId,
    wasCompressed: true,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
    newStoragePath,
  }
}
