import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processReferenceImageCompression } from '@/lib/reference-image-compression'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const SIZE_THRESHOLD = 5 * 1024 * 1024 // 5 MB
const DEFAULT_LIMIT = 50

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), 200)

    const supabase = createServiceClient()

    const { data: images, error } = await supabase
      .from(T.reference_images)
      .select('id, storage_path, file_size')
      .gt('file_size', SIZE_THRESHOLD)
      .order('file_size', { ascending: false })
      .limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({
        message: 'No oversized reference images found',
        total: 0,
        compressed: 0,
        skipped: 0,
        errors: 0,
        results: [],
      })
    }

    let compressed = 0
    let skipped = 0
    let errors = 0
    const results = []

    for (const img of images) {
      const result = await processReferenceImageCompression(img.id, img.storage_path)
      results.push(result)

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
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
