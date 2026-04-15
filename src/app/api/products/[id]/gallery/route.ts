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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyImageFilters(q: any, {
  productId,
  sceneId,
  approvalStatus,
  mediaType,
}: {
  productId: string
  sceneId: string | null
  approvalStatus: string | null
  mediaType: string | null
}) {
  let result = q.eq('product_id', productId)

  if (sceneId) {
    result = result.eq('scene_id', sceneId)
  }
  if (approvalStatus) {
    result = result.eq('approval_status', approvalStatus)
  }
  if (mediaType && mediaType !== 'all') {
    result = result.eq('media_type', mediaType)
  }

  return result
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  const { searchParams } = request.nextUrl
  const sceneId = searchParams.get('scene_id')
  const approvalStatus = searchParams.get('approval_status')
  const mediaType = searchParams.get('media_type')
  const sortParam = searchParams.get('sort')
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE, 1), 200)
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

  try {
    const supabase = createServiceClient()

    const countQuery = applyImageFilters(
      supabase.from(T.generated_images).select('id', { count: 'exact', head: true }),
      { productId, sceneId, approvalStatus, mediaType }
    )
    const { count: totalCount, error: countError } = await countQuery

    if (countError) {
      return NextResponse.json({ error: 'Failed to count images' }, { status: 500 })
    }

    let imagesQuery = applyImageFilters(
      supabase.from(T.generated_images).select(GALLERY_IMAGE_SELECT),
      { productId, sceneId, approvalStatus, mediaType }
    )

    if (sortParam === 'oldest') {
      imagesQuery = imagesQuery.order('created_at', { ascending: true })
    } else if (sortParam === 'variation') {
      imagesQuery = imagesQuery
        .order('variation_number', { ascending: true })
        .order('created_at', { ascending: false })
    } else {
      imagesQuery = imagesQuery.order('created_at', { ascending: false })
    }

    imagesQuery = imagesQuery.range(offset, offset + limit - 1)

    const { data: images, error: imagesError } = await imagesQuery as {
      data: GalleryImageRecord[] | null
      error: { message: string } | null
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
          .select('id, prompt_template_id, final_prompt, reference_set_id, texture_set_id, product_image_count, texture_image_count')
          .eq('product_id', productId)
          .in('id', jobIds)
      : { data: [], error: null }

    if (jobsError) {
      return NextResponse.json({ error: 'Failed to fetch job metadata' }, { status: 500 })
    }

    const jobTemplateMap = new Map((jobs || []).map((job) => [job.id, job.prompt_template_id]))
    const jobPromptMap = new Map((jobs || []).map((job) => [job.id, job.final_prompt as string | null]))
    const jobRefSetMap = new Map((jobs || []).map((job) => [job.id, job.reference_set_id as string | null]))
    const jobTextureSetMap = new Map((jobs || []).map((job) => [job.id, job.texture_set_id as string | null]))
    const jobProductImageCountMap = new Map((jobs || []).map((job) => [job.id, job.product_image_count as number | null]))
    const jobTextureImageCountMap = new Map((jobs || []).map((job) => [job.id, job.texture_image_count as number | null]))

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
    const allImageBucketPaths = Array.from(new Set([...thumbPaths, ...previewPaths, ...fallbackPaths]))

    const videoItems = (images || []).filter((img) => img.media_type === 'video')
    const videoPaths = videoItems
      .map((video) => video.storage_path)
      .filter(Boolean) as string[]
    const videoThumbPaths = videoItems
      .map((video) => video.thumb_storage_path)
      .filter(Boolean) as string[]
    const allVideoBucketPaths = Array.from(new Set([...videoPaths, ...videoThumbPaths]))

    const [signedImageResult, signedVideoResult] = await Promise.all([
      allImageBucketPaths.length > 0
        ? supabase.storage.from('generated-images').createSignedUrls(allImageBucketPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null, error: null }),
      allVideoBucketPaths.length > 0
        ? supabase.storage.from('generated-videos').createSignedUrls(allVideoBucketPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null, error: null }),
    ])

    if (signedImageResult.error) {
      console.error('[Gallery] Failed to sign image URLs:', signedImageResult.error.message)
    }
    if (signedVideoResult.error) {
      console.error('[Gallery] Failed to sign video URLs:', signedVideoResult.error.message)
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

    const signedImages = (images || []).map((img) => ({
      ...img,
      public_url: img.media_type === 'video'
        ? (img.storage_path ? (signedVideos.get(img.storage_path) ?? null) : null)
        : (!img.thumb_storage_path && !img.preview_storage_path && img.storage_path
            ? (signedImageBucket.get(img.storage_path) ?? null)
            : null),
      preview_public_url: img.media_type === 'video'
        ? null
        : (img.preview_storage_path ? (signedImageBucket.get(img.preview_storage_path) ?? null) : null),
      thumb_public_url: img.media_type === 'video'
        ? (img.thumb_storage_path ? (signedVideos.get(img.thumb_storage_path) ?? null) : null)
        : (img.thumb_storage_path ? (signedImageBucket.get(img.thumb_storage_path) ?? null) : null),
      prompt_template_id: img.job_id ? (jobTemplateMap.get(img.job_id) ?? null) : null,
      prompt: img.job_id ? (jobPromptMap.get(img.job_id) ?? null) : null,
      reference_set_id: img.job_id ? (jobRefSetMap.get(img.job_id) ?? null) : null,
      texture_set_id: img.job_id ? (jobTextureSetMap.get(img.job_id) ?? null) : null,
      product_image_count: img.job_id ? (jobProductImageCountMap.get(img.job_id) ?? null) : null,
      texture_image_count: img.job_id ? (jobTextureImageCountMap.get(img.job_id) ?? null) : null,
    }))

    return NextResponse.json({
      images: signedImages,
      total: totalCount ?? signedImages.length,
      offset,
      limit,
      has_more: offset + signedImages.length < (totalCount ?? signedImages.length),
    })
  } catch (err) {
    console.error('[Gallery] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
