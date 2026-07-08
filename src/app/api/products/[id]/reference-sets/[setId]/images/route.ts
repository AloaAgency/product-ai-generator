import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processReferenceImageCompression } from '@/lib/reference-image-compression'
import { mapWithConcurrency } from '@/lib/concurrency'
import {
  MAX_REFERENCE_IMAGES,
  ALLOWED_REFERENCE_IMAGE_TYPES,
  MAX_REFERENCE_IMAGE_SIZE_BYTES,
  MAX_LIST_ROWS,
  MAX_FILE_NAME_LENGTH,
  parseRequestBody,
  sanitizeStorageFileExtension,
} from '@/lib/request-guards'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
// Bounded: each upload holds a full-size image in memory during Sharp re-encode.
const UPLOAD_CONCURRENCY = 3

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()

    const contentType = request.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const parsed = await parseRequestBody(request)
      if (!parsed.ok) return parsed.response
      const body = parsed.body
      const uploads = (body?.uploads || []) as Array<{
        storage_path: string
        file_name: string
        mime_type: string
        file_size: number
        display_order?: number
      }>

      if (!Array.isArray(uploads) || uploads.length === 0) {
        return NextResponse.json({ error: 'No uploads provided' }, { status: 400 })
      }

      // One round trip: exact count is computed server-side; only the
      // max-display_order row is transferred instead of every row in the set.
      const { data: existing, count: existingCount0 } = await supabase
        .from(T.reference_images)
        .select('display_order', { count: 'exact' })
        .eq('reference_set_id', setId)
        .order('display_order', { ascending: false })
        .limit(1)

      const existingCount = existingCount0 ?? 0

      if (existingCount + uploads.length > MAX_REFERENCE_IMAGES) {
        return NextResponse.json(
          {
            error: `Maximum ${MAX_REFERENCE_IMAGES} reference images allowed per set. Currently ${existingCount}, trying to add ${uploads.length}.`,
          },
          { status: 400 }
        )
      }

      // Validate every upload before touching the DB.
      const expectedPrefix = `products/${productId}/refs/${setId}/`
      for (const upload of uploads) {
        if (typeof upload.storage_path !== 'string' || !upload.storage_path.startsWith(expectedPrefix)) {
          return NextResponse.json(
            { error: 'Invalid storage_path: path does not match the expected location for this reference set' },
            { status: 400 }
          )
        }
        if (typeof upload.mime_type === 'string' && !ALLOWED_REFERENCE_IMAGE_TYPES.has(upload.mime_type)) {
          return NextResponse.json(
            { error: `File type "${upload.mime_type}" is not allowed` },
            { status: 400 }
          )
        }
        if (typeof upload.file_name === 'string' && upload.file_name.length > MAX_FILE_NAME_LENGTH) {
          return NextResponse.json(
            { error: `file_name must be ${MAX_FILE_NAME_LENGTH} characters or fewer` },
            { status: 400 }
          )
        }
      }

      // Precompute display orders so parallel workers don't race on a shared counter.
      let nextOrder = (existing?.[0]?.display_order ?? -1) + 1
      const displayOrders = uploads.map((upload) =>
        typeof upload.display_order === 'number' && Number.isFinite(upload.display_order) && upload.display_order >= 0
          ? upload.display_order
          : nextOrder++
      )

      const results = await mapWithConcurrency(uploads, UPLOAD_CONCURRENCY, async (upload, index) => {
        const { data: record, error: dbError } = await supabase
          .from(T.reference_images)
          .insert({
            reference_set_id: setId,
            storage_path: upload.storage_path,
            file_name: upload.file_name,
            mime_type: upload.mime_type,
            file_size: upload.file_size,
            display_order: displayOrders[index],
          })
          .select()
          .single()

        if (dbError) {
          return { file: upload.file_name, error: dbError.message }
        }
        // Compress before responding — merge updated metadata into the response
        const compression = await processReferenceImageCompression(record.id, record.storage_path)
        if (compression.wasCompressed && compression.newStoragePath && !compression.error) {
          record.storage_path = compression.newStoragePath
          record.mime_type = 'image/webp'
          record.file_size = compression.compressedSize
        }
        return record
      })

      return NextResponse.json(results, { status: 201 })
    }

    const formData = await request.formData()
    const files = formData.getAll('files') as File[]

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    for (const file of files) {
      if (!ALLOWED_REFERENCE_IMAGE_TYPES.has(file.type)) {
        return NextResponse.json({ error: `File type "${file.type}" is not allowed. Allowed types: JPEG, PNG, WebP, GIF, AVIF` }, { status: 400 })
      }
      if (file.size > MAX_REFERENCE_IMAGE_SIZE_BYTES) {
        return NextResponse.json({ error: `File "${file.name}" exceeds the 50 MB size limit` }, { status: 400 })
      }
    }

    // Get current image count and max display_order in one round trip:
    // exact count is computed server-side; only the top row is transferred.
    const { data: existing, count: existingCount0 } = await supabase
      .from(T.reference_images)
      .select('display_order', { count: 'exact' })
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: false })
      .limit(1)

    const existingCount = existingCount0 ?? 0

    if (existingCount + files.length > MAX_REFERENCE_IMAGES) {
      return NextResponse.json(
        { error: `Maximum ${MAX_REFERENCE_IMAGES} reference images allowed per set. Currently ${existingCount}, trying to add ${files.length}.` },
        { status: 400 }
      )
    }

    const firstOrder = (existing?.[0]?.display_order ?? -1) + 1

    const results = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file, index) => {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const extension = sanitizeStorageFileExtension(file.name)
      const storageFileName = `${Date.now()}-${randomUUID()}${extension}`
      const storagePath = `products/${productId}/refs/${setId}/${storageFileName}`

      const { error: uploadError } = await supabase.storage
        .from('reference-images')
        .upload(storagePath, buffer, {
          contentType: file.type,
          upsert: true,
        })

      if (uploadError) {
        return { file: file.name, error: uploadError.message }
      }

      const { data: record, error: dbError } = await supabase
        .from(T.reference_images)
        .insert({
          reference_set_id: setId,
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type,
          file_size: file.size,
          display_order: firstOrder + index,
        })
        .select()
        .single()

      if (dbError) {
        return { file: file.name, error: dbError.message }
      }
      return record
    })

    return NextResponse.json(results, { status: 201 })
  } catch (err) {
    logger.error('[ReferenceImages POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { setId } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.reference_images)
      .select('*')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: true })
      .limit(MAX_LIST_ROWS)

    if (error) { logger.error('[ReferenceImages GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }

    const paths = (data || [])
      .map((img) => img.storage_path)
      .filter(Boolean) as string[]

    let signedMap = new Map<string, string>()
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage
        .from('reference-images')
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      if (signed) {
        signedMap = new Map(
          signed
            .filter((item) => item?.signedUrl && item?.path)
            .map((item) => [item.path!, item.signedUrl!])
        )
      }
    }

    const images = (data || []).map((img) => ({
      ...img,
      public_url: img.storage_path ? (signedMap.get(img.storage_path) ?? null) : null,
    }))

    return NextResponse.json(images)
  } catch (err) {
    logger.error('[ReferenceImages GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
