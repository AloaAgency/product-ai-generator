import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_PAGE_SIZE = 48
const GALLERY_IMAGE_SELECT = [
  'id',
  'product_id',
  'job_id',
  'scene_id',
  'scene_name',
  'variation_number',
  'storage_path',
  'thumb_storage_path',
  'preview_storage_path',
  'mime_type',
  'file_size',
  'approval_status',
  'notes',
  'media_type',
  'created_at',
].join(', ')

type GalleryImageRecord = {
  id: string
  product_id: string | null
  job_id: string | null
  scene_id: string | null
  scene_name: string | null
  variation_number: number | null
  storage_path: string | null
  thumb_storage_path: string | null
  preview_storage_path: string | null
  mime_type: string | null
  file_size: number | null
  approval_status: string | null
  notes: string | null
  media_type: string | null
  created_at: string | null
}

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
  const { projectId } = await params
  const { searchParams } = request.nextUrl
  const approvalStatus = searchParams.get('approval_status')
  const mediaType = searchParams.get('media_type')
  const productIdFilter = searchParams.get('product_id')
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE, 1), 200)
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

  try {
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

    // Count and image queries are independent — run in parallel
    const [countResult, imagesResult] = await Promise.all([
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

    const imageItems = (images || []).filter((img) => img.media_type !== 'video')
    const thumbPaths = imageItems
      .map((img) => img.thumb_storage_path)
      .filter(Boolean) as string[]
    const previewPaths = imageItems
      .map((img) => img.preview_storage_path)
      .filter(Boolean) as string[]
    const fallbackPaths = imageItems
      .filter((img) => !img.thumb_storage_path && !img.preview_storage_path && img.storage_path)
      .map((img) => img.storage_path)
      .filter(Boolean) as string[]

    const lightweightImagePaths = Array.from(new Set([...thumbPaths, ...previewPaths, ...fallbackPaths]))

    const videoItems = (images || []).filter((img) => img.media_type === 'video')
    const videoPaths = videoItems
      .map((video) => video.storage_path)
      .filter(Boolean) as string[]
    const videoThumbPaths = videoItems
      .map((video) => video.thumb_storage_path)
      .filter(Boolean) as string[]
    const allVideoBucketPaths = Array.from(new Set([...videoPaths, ...videoThumbPaths]))

    const [signedImageResult, signedVideoResult] = await Promise.all([
      lightweightImagePaths.length > 0
        ? supabase.storage.from('generated-images').createSignedUrls(lightweightImagePaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null, error: null }),
      allVideoBucketPaths.length > 0
        ? supabase.storage.from('generated-videos').createSignedUrls(allVideoBucketPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null, error: null }),
    ])

    if (signedImageResult.error) {
      console.error('[ProjectGallery] Failed to sign image URLs:', signedImageResult.error.message)
    }
    if (signedVideoResult.error) {
      console.error('[ProjectGallery] Failed to sign video URLs:', signedVideoResult.error.message)
    }

    const signedImageBucket = new Map<string, string>(
      (signedImageResult.data || [])
        .filter((item) => item?.signedUrl && item?.path)
        .map((item) => [item.path!, item.signedUrl])
    )
    const signedVideos = new Map<string, string>(
      (signedVideoResult.data || [])
        .filter((item) => item?.signedUrl && item?.path)
        .map((item) => [item.path!, item.signedUrl])
    )

    const productImageMap = new Map<string, Array<GalleryImageRecord & {
      public_url: string | null
      preview_public_url: string | null
      thumb_public_url: string | null
      prompt: string | null
    }>>()

    for (const productId of productIds) {
      productImageMap.set(productId, [])
    }

    for (const image of images || []) {
      if (!image.product_id || !productImageMap.has(image.product_id)) continue

      productImageMap.get(image.product_id)!.push({
        ...image,
        public_url: image.media_type === 'video'
          ? (image.storage_path ? (signedVideos.get(image.storage_path) ?? null) : null)
          : (!image.thumb_storage_path && !image.preview_storage_path && image.storage_path
              ? (signedImageBucket.get(image.storage_path) ?? null)
              : null),
        preview_public_url: image.media_type === 'video'
          ? null
          : (image.preview_storage_path ? (signedImageBucket.get(image.preview_storage_path) ?? null) : null),
        thumb_public_url: image.media_type === 'video'
          ? (image.thumb_storage_path ? (signedVideos.get(image.thumb_storage_path) ?? null) : null)
          : (image.thumb_storage_path ? (signedImageBucket.get(image.thumb_storage_path) ?? null) : null),
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

    const scopedStatusCount = async (status: string) => {
      const query = productIds.length === 1
        ? supabase.from(T.generated_images).select('id', { count: 'exact', head: true }).eq('product_id', productIds[0])
        : supabase.from(T.generated_images).select('id', { count: 'exact', head: true }).in('product_id', productIds)

      return query.eq('approval_status', status)
    }

    const [rejectedResult, changesResult] = await Promise.all([
      approvalStatus !== 'rejected' ? scopedStatusCount('rejected') : Promise.resolve({ count: null }),
      approvalStatus !== 'request_changes' ? scopedStatusCount('request_changes') : Promise.resolve({ count: null }),
    ])

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
    console.error('[ProjectGallery] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
