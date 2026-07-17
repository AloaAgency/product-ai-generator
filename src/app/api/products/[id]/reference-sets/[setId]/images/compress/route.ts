import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processReferenceImageCompression } from '@/lib/reference-image-compression'
import { mapWithConcurrency } from '@/lib/concurrency'
import { isAdminAuthorizedNode } from '@/lib/server-secrets'
import { logger } from '@/lib/server-logger'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Bounded: each item holds a full-size image in memory during Sharp re-encode.
const COMPRESS_CONCURRENCY = 3

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  if (!isAdminAuthorizedNode(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { setId } = await params
    const supabase = createServiceClient()

    const { data: images, error } = await supabase
      .from(T.reference_images)
      .select('id, storage_path, file_size')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: true })

    if (error) {
      logger.error('[ReferenceImagesCompress GET]', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ total: 0, compressed: 0, skipped: 0, errors: 0, results: [] })
    }

    // processReferenceImageCompression reports failures via the result's
    // error field rather than throwing, so the pool never short-circuits.
    const results = await mapWithConcurrency(images, COMPRESS_CONCURRENCY, (img) =>
      processReferenceImageCompression(img.id, img.storage_path)
    )

    let compressed = 0
    let skipped = 0
    let errors = 0
    for (const result of results) {
      if (result.error) {
        errors++
      } else if (result.wasCompressed) {
        compressed++
      } else {
        skipped++
      }
    }

    return NextResponse.json({
      total: images.length,
      compressed,
      skipped,
      errors,
      results,
    })
  } catch (err) {
    logger.error('[ReferenceImagesCompress] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
