import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, sanitizeStorageFileExtension } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_FILES_PER_REQUEST = 50

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    const files = body.files as Array<{ file_name: string; mime_type: string; file_size: number }>
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json({ error: `Cannot upload more than ${MAX_FILES_PER_REQUEST} files at once` }, { status: 400 })
    }
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.has(file.mime_type)) {
        return NextResponse.json({ error: `File type "${file.mime_type}" is not allowed. Allowed types: JPEG, PNG, WebP, GIF, AVIF` }, { status: 400 })
      }
      if (typeof file.file_size === 'number' && file.file_size > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json({ error: `File "${file.file_name}" exceeds the 50 MB size limit` }, { status: 400 })
      }
    }

    // Find or create a "manual upload" placeholder job so the gallery query picks up these images
    const { data: existingJob } = await supabase
      .from(T.generation_jobs)
      .select('id')
      .eq('product_id', productId)
      .eq('final_prompt', '__manual_upload__')
      .single()

    let jobId: string
    if (existingJob) {
      jobId = existingJob.id
    } else {
      const { data: newJob, error: jobError } = await supabase
        .from(T.generation_jobs)
        .insert({
          id: randomUUID(),
          product_id: productId,
          final_prompt: '__manual_upload__',
          variation_count: 0,
          status: 'completed',
        })
        .select('id')
        .single()
      if (jobError || !newJob) {
        return NextResponse.json({ error: 'Failed to create upload job' }, { status: 500 })
      }
      jobId = newJob.id
    }

    // variation_number must be unique per (job_id, media_type) — uq_generated_images_job_variation_media.
    // All manual uploads share one placeholder job, so continue from the current max.
    const { data: maxRow } = await supabase
      .from(T.generated_images)
      .select('variation_number')
      .eq('job_id', jobId)
      .order('variation_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    const baseVariation = (maxRow?.variation_number ?? -1) + 1

    const results = await Promise.all(files.map(async (file, index) => {
      // Wrap each file so an unexpected throw (network error, storage client
      // rejection) degrades to a per-file error entry instead of rejecting the
      // whole Promise.all — which would discard the results of sibling files
      // that already committed a generated_images row, leaving them orphaned
      // and invisible to the client behind a generic 500.
      try {
        const extension = sanitizeStorageFileExtension(file.file_name)
        const storageFileName = `${Date.now()}-${randomUUID()}${extension}`
        const storagePath = `products/${productId}/uploads/${storageFileName}`

        const { data: signedData, error: signError } = await supabase.storage
          .from('generated-images')
          .createSignedUploadUrl(storagePath, { upsert: true })

        if (signError || !signedData?.signedUrl) {
          return { file_name: file.file_name, error: signError?.message || 'Failed to sign' }
        }

        const imageId = randomUUID()
        const { data: image, error: insertError } = await supabase
          .from(T.generated_images)
          .insert({
            id: imageId,
            product_id: productId,
            job_id: jobId,
            storage_path: storagePath,
            mime_type: file.mime_type,
            file_size: file.file_size || null,
            media_type: 'image',
            variation_number: baseVariation + index,
            approval_status: 'pending',
          })
          .select()
          .single()

        if (insertError || !image) {
          return { file_name: file.file_name, error: insertError?.message || 'Insert failed' }
        }

        return { signed_url: signedData.signedUrl, image }
      } catch (err) {
        logger.error('[GalleryUpload] Per-file error:', err)
        return {
          file_name: file.file_name,
          error: err instanceof Error ? err.message : 'Upload preparation failed',
        }
      }
    }))

    // Return results immediately so client can start uploading.
    // After response, we'll generate thumbnails asynchronously via a separate call.
    // The client must call POST /api/images/generate-thumbs after uploading files.
    return NextResponse.json(results, { status: 201 })
  } catch (err) {
    logger.error('[GalleryUpload] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
