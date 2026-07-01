import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { optionalUuid, requireUuid } from '@/lib/request-guards'
import { logger } from '@/lib/logger'

// Per-day generation activity for a project, used to correlate asset generation with
// billing. Counts ALL generated assets regardless of approval status — rejected and
// pending assets still incurred generation cost, so excluding them would understate spend.

const PAGE_SIZE = 1000
// Safety cap so a runaway project can't scan unbounded rows. If hit, `truncated` is set.
const MAX_ROWS = 100_000

type ActivityRow = {
  created_at: string | null
  media_type: string | null
}

type DayBucket = {
  date: string
  images: number
  videos: number
  total: number
}

// getTimezoneOffset() returns minutes to ADD to local time to reach UTC (e.g. 300 for
// UTC-5), so we subtract it to shift a UTC instant into the viewer's local day. This keeps
// day boundaries aligned with what the user sees, so late-night generations bucket correctly.
function localDateKey(createdAt: string, tzOffsetMinutes: number): string | null {
  const ms = Date.parse(createdAt)
  if (Number.isNaN(ms)) return null
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId: rawProjectId } = await params
  const { searchParams } = request.nextUrl
  const rawProductIdFilter = searchParams.get('product_id')
  const mediaType = searchParams.get('media_type')
  // Clamp to a sane range; anything beyond ±24h is meaningless as a timezone offset.
  const tzOffsetMinutes = Math.max(-1440, Math.min(1440, Number(searchParams.get('tz_offset')) || 0))

  try {
    const projectId = requireUuid(rawProjectId, 'project id')
    const productIdFilter = optionalUuid(rawProductIdFilter, 'product id')
    const supabase = createServiceClient()

    let productsQuery = supabase
      .from(T.products)
      .select('id')
      .eq('project_id', projectId)

    if (productIdFilter) {
      productsQuery = productsQuery.eq('id', productIdFilter)
    }

    const { data: products, error: productsError } = await productsQuery as {
      data: { id: string }[] | null
      error: { message: string } | null
    }

    if (productsError) {
      return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 })
    }

    if (!products || products.length === 0) {
      return NextResponse.json({ days: [], total_images: 0, total_videos: 0, truncated: false })
    }

    const productIds = products.map((product) => product.id)

    const buckets = new Map<string, DayBucket>()
    let totalImages = 0
    let totalVideos = 0
    let scanned = 0
    let truncated = false

    for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
      let query = supabase
        .from(T.generated_images)
        .select('created_at, media_type')

      query = productIds.length === 1
        ? query.eq('product_id', productIds[0])
        : query.in('product_id', productIds)

      if (mediaType && mediaType !== 'all') {
        query = query.eq('media_type', mediaType)
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1) as {
          data: ActivityRow[] | null
          error: { message: string } | null
        }

      if (error) {
        return NextResponse.json({ error: 'Failed to aggregate generation activity' }, { status: 500 })
      }

      const rows = data || []
      for (const row of rows) {
        if (!row.created_at) continue
        const key = localDateKey(row.created_at, tzOffsetMinutes)
        if (!key) continue
        const isVideo = row.media_type === 'video'
        const bucket = buckets.get(key) ?? { date: key, images: 0, videos: 0, total: 0 }
        if (isVideo) {
          bucket.videos += 1
          totalVideos += 1
        } else {
          bucket.images += 1
          totalImages += 1
        }
        bucket.total += 1
        buckets.set(key, bucket)
      }

      scanned += rows.length
      if (rows.length < PAGE_SIZE) break
      if (scanned >= MAX_ROWS) {
        truncated = true
        break
      }
    }

    // Newest day first, matching the gallery's default ordering.
    const days = Array.from(buckets.values()).sort((a, b) => (a.date < b.date ? 1 : -1))

    return NextResponse.json({
      days,
      total_images: totalImages,
      total_videos: totalVideos,
      truncated,
    })
  } catch (err) {
    logger.error('[GenerationSummary] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
