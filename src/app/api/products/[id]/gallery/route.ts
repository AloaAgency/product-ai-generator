import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import {
  GALLERY_MEDIA_TYPES,
  GALLERY_SORT_OPTIONS,
  requireUuid,
  sanitizeApprovalStatus,
  sanitizePublicErrorMessage,
} from '@/lib/request-guards'
import {
  GALLERY_IMAGE_SELECT,
  type GalleryImageRecord,
  collectGalleryMediaPaths,
  createSignedUrlMap,
  resolveGallerySignedUrls,
} from '@/lib/gallery-media'
import { logger } from '@/lib/server-logger'

const DEFAULT_PAGE_SIZE = 48

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
  try {
    const { id } = await params
    const productId = requireUuid(id, 'product id')
    const { searchParams } = request.nextUrl
    const sceneId = searchParams.get('scene_id')
    const approvalStatus = sanitizeApprovalStatus(searchParams.get('approval_status'), { allowAll: true }) ?? null
    const mediaType = searchParams.get('media_type')
    const sortParam = searchParams.get('sort')
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE, 1), 200)
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

    if (sceneId) requireUuid(sceneId, 'scene id')
    if (mediaType && !GALLERY_MEDIA_TYPES.has(mediaType)) {
      return NextResponse.json({ error: 'Invalid media_type' }, { status: 400 })
    }
    if (sortParam && !GALLERY_SORT_OPTIONS.has(sortParam)) {
      return NextResponse.json({ error: 'Invalid sort' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const countQuery = applyImageFilters(
      supabase.from(T.generated_images).select('id', { count: 'exact', head: true }),
      { productId, sceneId, approvalStatus, mediaType }
    )

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

    // Count and page-fetch are independent — run them in one round-trip instead of serially.
    const [{ count: totalCount, error: countError }, imagesResult] = await Promise.all([
      countQuery,
      imagesQuery as Promise<{
        data: GalleryImageRecord[] | null
        error: { message: string } | null
      }>,
    ])

    if (countError) {
      return NextResponse.json({ error: 'Failed to count images' }, { status: 500 })
    }

    const { data: images, error: imagesError } = imagesResult

    if (imagesError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    const jobIds = Array.from(
      new Set((images || []).map((image) => image.job_id).filter((value): value is string => Boolean(value)))
    )

    const [jobsResult, jobRefSetsResult] = await Promise.all([
      jobIds.length > 0
        ? supabase
            .from(T.generation_jobs)
            .select('id, prompt_template_id, final_prompt')
            .eq('product_id', productId)
            .in('id', jobIds)
        : Promise.resolve({ data: [], error: null }),
      jobIds.length > 0
        ? supabase
            .from(T.generation_job_reference_sets)
            .select('job_id, reference_set_id, role, display_order, image_count, subject_label')
            .in('job_id', jobIds)
            .order('display_order', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ])

    if (jobsResult.error) {
      return NextResponse.json({ error: 'Failed to fetch job metadata' }, { status: 500 })
    }
    if (jobRefSetsResult.error) {
      return NextResponse.json({ error: 'Failed to fetch job reference sets' }, { status: 500 })
    }

    type JobRefSetEntry = {
      reference_set_id: string
      role: 'subject' | 'texture'
      display_order: number
      image_count: number | null
      subject_label: string | null
    }
    const jobs = jobsResult.data || []
    const jobTemplateMap = new Map(jobs.map((job) => [job.id, job.prompt_template_id]))
    const jobPromptMap = new Map(jobs.map((job) => [job.id, job.final_prompt as string | null]))
    const jobRefSetsMap = new Map<string, JobRefSetEntry[]>()
    for (const row of (jobRefSetsResult.data || []) as Array<JobRefSetEntry & { job_id: string }>) {
      const arr = jobRefSetsMap.get(row.job_id) ?? []
      arr.push({
        reference_set_id: row.reference_set_id,
        role: row.role,
        display_order: row.display_order,
        image_count: row.image_count,
        subject_label: row.subject_label,
      })
      jobRefSetsMap.set(row.job_id, arr)
    }

    const { imagePaths, videoPaths } = collectGalleryMediaPaths(images || [])

    const [signedImageResult, signedVideoResult] = await Promise.all([
      createSignedUrlMap(supabase, 'generated-images', imagePaths),
      createSignedUrlMap(supabase, 'generated-videos', videoPaths),
    ])

    if (signedImageResult.error) {
      logger.error('[Gallery] Failed to sign image URLs:', signedImageResult.error)
    }
    if (signedVideoResult.error) {
      logger.error('[Gallery] Failed to sign video URLs:', signedVideoResult.error)
    }

    const signedImages = (images || []).map((img) => ({
      ...img,
      ...resolveGallerySignedUrls(img, signedImageResult.map, signedVideoResult.map),
      prompt_template_id: img.job_id ? (jobTemplateMap.get(img.job_id) ?? null) : null,
      prompt: img.job_id ? (jobPromptMap.get(img.job_id) ?? null) : null,
      reference_sets: img.job_id ? (jobRefSetsMap.get(img.job_id) ?? []) : [],
    }))

    return NextResponse.json({
      images: signedImages,
      total: totalCount ?? signedImages.length,
      offset,
      limit,
      has_more: offset + signedImages.length < (totalCount ?? signedImages.length),
    })
  } catch (err) {
    logger.error(`[Gallery] ${sanitizePublicErrorMessage(err, { fallback: 'Unexpected error' })}`)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
