import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { processReferenceImageCompression } from '@/lib/reference-image-compression'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { setId } = await params
    const supabase = createServiceClient()

    const { data: images, error } = await supabase
      .from(T.reference_images)
      .select('id, storage_path, file_size')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({ total: 0, compressed: 0, skipped: 0, errors: 0, results: [] })
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
