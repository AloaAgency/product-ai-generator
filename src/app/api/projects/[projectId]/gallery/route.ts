import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { optionalUuid, requireUuid } from '@/lib/request-guards'
import {
  GALLERY_IMAGE_SELECT,
  type GalleryImageRecord,
  type GallerySignedUrls,
  collectGalleryMediaPaths,
  createSignedUrlMap,
  resolveGallerySignedUrls,
} from '@/lib/gallery-media'
import { logger } from '@/lib/server-logger'

const DEFAULT_PAGE_SIZE = 48

type ProductRecord = {
  id: string
  name: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyProjectGalleryFilters(q: any, {
  productIds,
  approvalStatus,
  mediaType,
}: {
  productIds: string[]
  approvalStatus: string | null
  mediaType: string | null
}) {
  let result = productIds.length === 1
    ? q.eq('product_id', productIds[0])
    : q.in('product_id', productIds)

  if (approvalStatus === 'rejected') {
    result = result.eq('approval_status', 'rejected')
  } else if (approvalStatus === 'request_changes') {
    result = result.eq('approval_status', 'request_changes')
  } else if (approvalStatus) {
    result = result.eq('approval_status', approvalStatus)
  } else {
    result = result.or('approval_status.is.null,approval_status.in.(approved,pending)')
  }

  if (mediaType && mediaType !== 'all') {
    result = result.eq('media_type', mediaType)
  }

  return result
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId: rawProjectId } = await params
  const { searchParams } = request.nextUrl
  const approvalStatus = searchParams.get('approval_status')
  const mediaType = searchParams.get('media_type')
  const rawProductIdFilter = searchParams.get('product_id')
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE, 1), 200)
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

  try {
    const projectId = requireUuid(rawProjectId, 'project id')
    const productIdFilter = optionalUuid(rawProductIdFilter, 'product id')
    const supabase = createServiceClient()

    let productsQuery = supabase
      .from(T.products)
      .select('id, name')
      .eq('project_id', projectId)
      .order('name')

    if (productIdFilter) {
      productsQuery = productsQuery.eq('id', productIdFilter)
    }

    const { data: products, error: productsError } = await productsQuery as {
      data: ProductRecord[] | null
      error: { message: string } | null
    }

    if (productsError) {
      return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 })
    }

    if (!products || products.length === 0) {
      return NextResponse.json({
        products: [],
        total: 0,
        offset,
        limit,
        has_more: false,
        rejected_count: 0,
        request_changes_count: 0,
      })
    }

    const productIds = products.map((product) => product.id)

    const scopedStatusCount = (status: string) => {
      const q = productIds.length === 1
        ? supabase.from(T.generated_images).select('id', { count: 'exact', head: true }).eq('product_id', productIds[0])
        : supabase.from(T.generated_images).select('id', { count: 'exact', head: true }).in('product_id', productIds)
      return q.eq('approval_status', status)
    }

    // All four queries are independent once we have productIds — run together to save a round-trip.
    const [countResult, imagesResult, rejectedResult, changesResult] = await Promise.all([
      applyProjectGalleryFilters(
        supabase.from(T.generated_images).select('id', { count: 'exact', head: true }),
        { productIds, approvalStatus, mediaType }
      ),
      applyProjectGalleryFilters(
        supabase.from(T.generated_images).select(GALLERY_IMAGE_SELECT),
        { productIds, approvalStatus, mediaType }
      )
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      approvalStatus !== 'rejected' ? scopedStatusCount('rejected') : Promise.resolve({ count: null }),
      approvalStatus !== 'request_changes' ? scopedStatusCount('request_changes') : Promise.resolve({ count: null }),
    ])

    const { count: totalCount, error: countError } = countResult
    const { data: images, error: imagesError } = imagesResult as {
      data: GalleryImageRecord[] | null
      error: { message: string } | null
    }

    if (countError) {
      return NextResponse.json({ error: 'Failed to count images' }, { status: 500 })
    }

    if (imagesError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    const jobIds = Array.from(
      new Set((images || []).map((image) => image.job_id).filter((value): value is string => Boolean(value)))
    )

    const { data: jobs, error: jobsError } = jobIds.length > 0
      ? await supabase
          .from(T.generation_jobs)
          .select('id, product_id, final_prompt')
          .in('id', jobIds)
      : { data: [], error: null }

    if (jobsError) {
      return NextResponse.json({ error: 'Failed to fetch job metadata' }, { status: 500 })
    }

    const jobPromptMap = new Map((jobs || []).map((job) => [job.id, job.final_prompt as string | null]))

    const { imagePaths, videoPaths } = collectGalleryMediaPaths(images || [])

    const [signedImageResult, signedVideoResult] = await Promise.all([
      createSignedUrlMap(supabase, 'generated-images', imagePaths),
      createSignedUrlMap(supabase, 'generated-videos', videoPaths),
    ])

    if (signedImageResult.error) {
      logger.error('[ProjectGallery] Failed to sign image URLs:', signedImageResult.error)
    }
    if (signedVideoResult.error) {
      logger.error('[ProjectGallery] Failed to sign video URLs:', signedVideoResult.error)
    }

    const productImageMap = new Map<string, Array<GalleryImageRecord & GallerySignedUrls & {
      prompt: string | null
    }>>()

    for (const productId of productIds) {
      productImageMap.set(productId, [])
    }

    for (const image of images || []) {
      if (!image.product_id || !productImageMap.has(image.product_id)) continue

      productImageMap.get(image.product_id)!.push({
        ...image,
        ...resolveGallerySignedUrls(image, signedImageResult.map, signedVideoResult.map),
        prompt: image.job_id ? (jobPromptMap.get(image.job_id) ?? null) : null,
      })
    }

    const result = products.map((product) => ({
      product_id: product.id,
      product_name: product.name ?? 'Untitled Product',
      images: productImageMap.get(product.id) || [],
    }))

    const filtered = productIdFilter
      ? result
      : result.filter((product) => product.images.length > 0)

    const total = totalCount ?? (images || []).length

    return NextResponse.json({
      products: filtered,
      total,
      offset,
      limit,
      has_more: offset + (images || []).length < total,
      rejected_count: rejectedResult.count ?? 0,
      request_changes_count: changesResult.count ?? 0,
    })
  } catch (err) {
    logger.error('[ProjectGallery] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
