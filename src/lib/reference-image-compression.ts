import { createServiceClient } from '@/lib/supabase/server'
import { compressReferenceImage, MAX_BUFFER_BYTES, type CompressResult } from '@/lib/image-utils'
import { T } from '@/lib/db-tables'
import { sanitizePublicErrorMessage } from '@/lib/request-guards'
import { redactSensitiveText } from '@/lib/redact-secrets'
import { logger } from '@/lib/server-logger'

const BUCKET = 'reference-images'

// Bounded retry for transient Supabase storage/DB failures. Network blips,
// rate limits and upstream 5xx responses are common for object storage and
// should not permanently fail a compression that would otherwise succeed.
const STORAGE_MAX_ATTEMPTS = 3
const STORAGE_RETRY_BASE_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Only transient/infrastructural errors are retried. Deterministic failures
// (object not found, quota exceeded, constraint violations) are returned
// immediately so callers surface them without added latency.
function isRetriableStorageError(message: string | null | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('network') ||
    m.includes('fetch failed') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    // Node errno codes for timed-out connects, transient DNS failures and
    // broken pipes — all as transient as ECONNRESET but spelled differently
    // (note ETIMEDOUT does not contain the substring "timeout").
    m.includes('etimedout') ||
    m.includes('eai_again') ||
    m.includes('epipe') ||
    m.includes('socket hang up') ||
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('service unavailable') ||
    m.includes('bad gateway') ||
    m.includes('gateway timeout') ||
    m.includes('server error') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504')
  )
}

/**
 * Run a Supabase operation that resolves to `{ error }`, retrying with linear
 * backoff while the error looks transient. Thrown errors (e.g. a network
 * exception before a response is formed) are treated the same way, and a
 * terminal exception is converted into an `{ error }` result rather than
 * rethrown: every caller in this module maps error results into a
 * CompressionResult, and the batch routes rely on that no-throw contract to
 * keep one bad item from aborting a whole mapWithConcurrency pool (a rethrow
 * at the db-update stage would also skip the orphaned-upload cleanup below).
 * Returns the final result (successful or not) so existing error-mapping
 * logic is unchanged.
 */
async function withStorageRetry<TResult extends { error: { message?: string } | null }>(
  op: () => PromiseLike<TResult>,
  label: string
): Promise<TResult> {
  let lastResult: TResult | undefined
  for (let attempt = 0; attempt < STORAGE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await op()
      if (!result.error) return result
      lastResult = result
      if (attempt < STORAGE_MAX_ATTEMPTS - 1 && isRetriableStorageError(result.error.message)) {
        // Redact before logging: storage error messages can echo request
        // details (signed URLs, auth query params) from the failed call.
        logger.warn(`${label}: retriable error on attempt ${attempt + 1}/${STORAGE_MAX_ATTEMPTS}: ${redactSensitiveText(result.error.message ?? '')}`)
        await sleep(STORAGE_RETRY_BASE_MS * (attempt + 1))
        continue
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt < STORAGE_MAX_ATTEMPTS - 1 && isRetriableStorageError(message)) {
        logger.warn(`${label}: retriable exception on attempt ${attempt + 1}/${STORAGE_MAX_ATTEMPTS}: ${redactSensitiveText(message)}`)
        await sleep(STORAGE_RETRY_BASE_MS * (attempt + 1))
        continue
      }
      // Terminal exception: synthesize an error result so callers flow through
      // the same failure mapping as a returned `{ error }`. `data` is left
      // undefined, which download-style call sites already treat as a failure.
      logger.warn(`${label}: terminal exception: ${redactSensitiveText(message)}`)
      return { error: { message } } as unknown as TResult
    }
  }
  // Unreachable in practice: the loop always returns on the final attempt.
  return lastResult as TResult
}

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

  // Download the original file (retried on transient storage errors)
  const { data: fileData, error: downloadError } = await withStorageRetry(
    () => supabase.storage.from(BUCKET).download(storagePath),
    'reference-image-compression:download'
  )

  if (downloadError || !fileData) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: 0,
      compressedSize: 0,
      error: sanitizePublicErrorMessage(downloadError?.message, { fallback: 'Download failed' }),
    }
  }

  // Reject oversized objects before materialising the Blob: arrayBuffer()
  // copies the entire payload into memory, so without this check a >100 MB
  // object is fully duplicated only to be rejected by the same ceiling inside
  // compressReferenceImage. Checking Blob.size costs nothing and fails first.
  if (fileData.size > MAX_BUFFER_BYTES) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: fileData.size,
      compressedSize: fileData.size,
      error: `File exceeds maximum size limit (${MAX_BUFFER_BYTES / 1024 / 1024} MB)`,
    }
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(await fileData.arrayBuffer())
  } catch (err) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: 0,
      compressedSize: 0,
      error: sanitizePublicErrorMessage(err, { fallback: 'Buffer conversion failed' }),
    }
  }

  let result: CompressResult
  try {
    result = await compressReferenceImage(buffer)
  } catch (err) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: buffer.length,
      compressedSize: buffer.length,
      error: sanitizePublicErrorMessage(err, { fallback: 'Compression failed' }),
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

  // Build new storage path with .webp extension. When the original path has
  // no extension the regex would not match and the replace would be a no-op —
  // the upsert upload below would then overwrite the customer's original
  // bytes at the same key. Append the extension instead so the original
  // object is never clobbered by a rename that silently failed.
  const hasExtension = /\.[^/.]+$/.test(storagePath)
  const newStoragePath = hasExtension
    ? storagePath.replace(/\.[^/.]+$/, '.webp')
    : `${storagePath}.webp`

  // Upload the compressed version (retried on transient storage errors)
  const { error: uploadError } = await withStorageRetry(
    () =>
      supabase.storage.from(BUCKET).upload(newStoragePath, result.buffer, {
        contentType: result.mimeType,
        upsert: true,
      }),
    'reference-image-compression:upload'
  )

  if (uploadError) {
    return {
      imageId,
      wasCompressed: false,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      error: sanitizePublicErrorMessage(uploadError.message, { fallback: 'Upload failed' }),
    }
  }

  // Update DB record before deleting the old file so a delete failure
  // never leaves the DB pointing at a path that no longer exists.
  // Retried on transient errors; the upload used upsert:true, so a retried
  // update targets the same already-uploaded object and stays idempotent.
  const { error: dbError } = await withStorageRetry(
    () =>
      supabase
        .from(T.reference_images)
        .update({
          storage_path: newStoragePath,
          mime_type: result.mimeType,
          file_size: result.compressedSize,
        })
        .eq('id', imageId),
    'reference-image-compression:db-update'
  )

  if (dbError) {
    // The DB still points at the original object, so the freshly uploaded
    // compressed copy is unreachable and would sit in billable storage
    // forever. Best-effort remove it so storage and DB stay consistent —
    // but only when the paths differ: when the original was already .webp
    // the upload replaced it in place, and removing it would delete the
    // customer's only copy.
    if (newStoragePath !== storagePath) {
      try {
        const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([newStoragePath])
        if (cleanupError) {
          logger.warn(`Failed to clean up orphaned compressed image '${newStoragePath}':`, redactSensitiveText(cleanupError.message ?? ''))
        }
      } catch (err) {
        logger.warn(`Failed to clean up orphaned compressed image '${newStoragePath}':`, redactSensitiveText(err instanceof Error ? err.message : String(err)))
      }
      // The compressed copy no longer exists — report the operation as a
      // no-op failure rather than advertising a path that was rolled back.
      return {
        imageId,
        wasCompressed: false,
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
        error: sanitizePublicErrorMessage(dbError.message, { fallback: 'DB update failed' }),
      }
    }
    return {
      imageId,
      wasCompressed: true,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      newStoragePath,
      error: sanitizePublicErrorMessage(dbError.message, { fallback: 'DB update failed' }),
    }
  }

  // Best-effort cleanup: remove old file if the extension changed.
  // A failure here only orphans a file in storage — the DB is already correct,
  // so we log and continue rather than surfacing an error to the caller.
  if (newStoragePath !== storagePath) {
    try {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove([storagePath])
      if (removeError) {
        logger.warn(`Failed to remove old reference image '${storagePath}':`, redactSensitiveText(removeError.message ?? ''))
      }
    } catch (err) {
      logger.warn(`Failed to remove old reference image '${storagePath}':`, redactSensitiveText(err instanceof Error ? err.message : String(err)))
    }
  }

  // Metering hook: one structured line per successful compression so storage
  // savings are observable in production logs (aggregate by scanning for the
  // event name). logger.info is level-gated, not user-facing.
  const savedBytes = result.originalSize - result.compressedSize
  logger.info('reference-image-compression: compressed', {
    imageId,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
    savedBytes,
    savedPercent: Math.round((savedBytes / result.originalSize) * 100),
  })

  return {
    imageId,
    wasCompressed: true,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
    newStoragePath,
  }
}
