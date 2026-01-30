import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id: productId } = await params
    const supabase = createServiceClient()
    const body = await request.json()

    const files = body.files as Array<{ file_name: string; mime_type: string; file_size: number }>
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
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

    const results = []

    for (const file of files) {
      const extension = file.file_name.includes('.')
        ? `.${file.file_name.split('.').pop()?.toLowerCase()}`
        : ''
      const storageFileName = `${Date.now()}-${randomUUID()}${extension}`
      const storagePath = `products/${productId}/uploads/${storageFileName}`

      const { data: signedData, error: signError } = await supabase.storage
        .from('generated-images')
        .createSignedUploadUrl(storagePath, { upsert: true })

      if (signError || !signedData?.signedUrl) {
        results.push({ file_name: file.file_name, error: signError?.message || 'Failed to sign' })
        continue
      }

      const imageId = randomUUID()
      const { data: image, error: insertError } = await supabase
        .from(T.generated_images)
        .insert({
          id: imageId,
          job_id: jobId,
          storage_path: storagePath,
          file_name: file.file_name,
          mime_type: file.mime_type,
          file_size: file.file_size || null,
          media_type: 'image',
          variation_number: 0,
          approval_status: 'pending',
        })
        .select()
        .single()

      if (insertError || !image) {
        results.push({ file_name: file.file_name, error: insertError?.message || 'Insert failed' })
        continue
      }

      results.push({
        signed_url: signedData.signedUrl,
        image,
      })
    }

    return NextResponse.json(results, { status: 201 })
  } catch (err) {
    console.error('[GalleryUpload] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
