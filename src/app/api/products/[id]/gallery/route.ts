import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_PAGE_SIZE = 48

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params
  const { searchParams } = request.nextUrl
  const jobId = searchParams.get('job_id')
  const approvalStatus = searchParams.get('approval_status')
  const mediaType = searchParams.get('media_type') // 'all' | 'image' | 'video'
  const sceneId = searchParams.get('scene_id')
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE, 1), 200)
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

  try {
    const supabase = createServiceClient()

    // Get all job IDs (and prompt_template_id + final_prompt + settings) for this product
    let jobsQuery = supabase
      .from(T.generation_jobs)
      .select('id, prompt_template_id, final_prompt, reference_set_id, texture_set_id, product_image_count, texture_image_count')
      .eq('product_id', productId)

    if (jobId) {
      jobsQuery = jobsQuery.eq('id', jobId)
    }

    const { data: jobs, error: jobsError } = await jobsQuery

    if (jobsError) {
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 })
    }

    const jobIds = (jobs || []).map((j) => j.id)
    const jobTemplateMap = new Map((jobs || []).map((j) => [j.id, j.prompt_template_id]))
    const jobPromptMap = new Map((jobs || []).map((j) => [j.id, j.final_prompt as string | null]))
    const jobRefSetMap = new Map((jobs || []).map((j) => [j.id, j.reference_set_id as string | null]))
    const jobTextureSetMap = new Map((jobs || []).map((j) => [j.id, j.texture_set_id as string | null]))
    const jobProductImageCountMap = new Map((jobs || []).map((j) => [j.id, j.product_image_count as number | null]))
    const jobTextureImageCountMap = new Map((jobs || []).map((j) => [j.id, j.texture_image_count as number | null]))

    // Fetch generated images - include both job-based and scene-based (job_id is null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyScope = (q: any): any => {
      if (sceneId) {
        return q.eq('scene_id', sceneId)
      }
      if (productSceneIds.length > 0 && jobIds.length > 0) {
        return q.or(
          `job_id.in.(${jobIds.join(',')}),scene_id.in.(${productSceneIds.join(',')})`
        )
      }
      if (jobIds.length > 0) {
        return q.in('job_id', jobIds)
      }
      if (productSceneIds.length > 0) {
        return q.in('scene_id', productSceneIds)
      }
      return q
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any): any => {
      let result = applyScope(q)
      if (approvalStatus) {
        result = result.eq('approval_status', approvalStatus)
      }
      if (mediaType && mediaType !== 'all') {
        result = result.eq('media_type', mediaType)
      }
      return result
    }

    // Resolve scene IDs for this product
    let productSceneIds: string[] = []
    if (!sceneId) {
      const { data: boards } = await supabase
        .from(T.storyboards)
        .select('id')
        .eq('product_id', productId)
      const boardIds = (boards || []).map((b) => b.id)

      if (boardIds.length > 0) {
        const { data: scenes } = await supabase
          .from(T.storyboard_scenes)
          .select('id')
          .in('storyboard_id', boardIds)
        productSceneIds = (scenes || []).map((s) => s.id)
      }
    }

    // Early exit if no scope filters match
    if (!sceneId && jobIds.length === 0 && productSceneIds.length === 0) {
      return NextResponse.json({ images: [], total: 0 })
    }

    // Get total count (head-only query)
    const countQuery = applyFilters(
      supabase.from(T.generated_images).select('id', { count: 'exact', head: true })
    )
    const { count: totalCount } = await countQuery

    // Fetch paginated images
    let imagesQuery = applyFilters(
      supabase.from(T.generated_images).select('*')
    )
    imagesQuery = imagesQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: images, error: imagesError } = await imagesQuery as { data: any[] | null; error: any }

    if (imagesError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    // Sign only thumbnail URLs for images (full-size signed on demand by lightbox)
    const imageItems = (images || []).filter((img) => img.media_type !== 'video')
    const thumbPaths = imageItems
      .map((img) => img.thumb_storage_path)
      .filter(Boolean) as string[]
    // For images without thumbnails, sign the full path as fallback
    const fallbackPaths = imageItems
      .filter((img) => !img.thumb_storage_path && img.storage_path)
      .map((img) => img.storage_path)
      .filter(Boolean) as string[]
    const allImageBucketPaths = Array.from(new Set([...thumbPaths, ...fallbackPaths]))

    const videoItems = (images || []).filter((img) => img.media_type === 'video')
    const videoPaths = videoItems
      .map((v) => v.storage_path)
      .filter(Boolean) as string[]
    const videoThumbPaths = videoItems
      .map((v) => v.thumb_storage_path)
      .filter(Boolean) as string[]
    const allVideoBucketPaths = [...videoPaths, ...videoThumbPaths]

    const [signedImageResult, signedVideoResult] = await Promise.all([
      allImageBucketPaths.length > 0
        ? supabase.storage.from('generated-images').createSignedUrls(allImageBucketPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null }),
      allVideoBucketPaths.length > 0
        ? supabase.storage.from('generated-videos').createSignedUrls(allVideoBucketPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null }),
    ])

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
        ? (signedVideos.get(img.storage_path) ?? null)
        : (!img.thumb_storage_path ? (signedImageBucket.get(img.storage_path) ?? null) : null),
      preview_public_url: null,
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
