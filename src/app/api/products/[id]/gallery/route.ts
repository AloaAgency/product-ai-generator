import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

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

  try {
    const supabase = createServiceClient()

    // Get all job IDs (and prompt_template_id) for this product
    let jobsQuery = supabase
      .from(T.generation_jobs)
      .select('id, prompt_template_id')
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

    // Fetch generated images - include both job-based and scene-based (job_id is null)
    let imagesQuery = supabase
      .from(T.generated_images)
      .select('*')

    if (sceneId) {
      // Filter by scene
      imagesQuery = imagesQuery.eq('scene_id', sceneId)
    } else if (jobIds.length > 0) {
      // Include job-based images OR scene-based images for this product's scenes
      // We need to get scene IDs from this product's storyboards
      const { data: boards } = await supabase
        .from(T.storyboards)
        .select('id')
        .eq('product_id', productId)
      const boardIds = (boards || []).map((b) => b.id)

      let productSceneIds: string[] = []
      if (boardIds.length > 0) {
        const { data: scenes } = await supabase
          .from(T.storyboard_scenes)
          .select('id')
          .in('storyboard_id', boardIds)
        productSceneIds = (scenes || []).map((s) => s.id)
      }

      // Use OR filter: job_id in jobIds OR scene_id in productSceneIds
      if (productSceneIds.length > 0) {
        imagesQuery = imagesQuery.or(
          `job_id.in.(${jobIds.join(',')}),scene_id.in.(${productSceneIds.join(',')})`
        )
      } else {
        imagesQuery = imagesQuery.in('job_id', jobIds)
      }
    } else {
      // No jobs - check for scene-based videos only
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
        const productSceneIds = (scenes || []).map((s) => s.id)
        if (productSceneIds.length > 0) {
          imagesQuery = imagesQuery.in('scene_id', productSceneIds)
        } else {
          return NextResponse.json({ images: [] })
        }
      } else {
        return NextResponse.json({ images: [] })
      }
    }

    if (approvalStatus) {
      imagesQuery = imagesQuery.eq('approval_status', approvalStatus)
    }

    if (mediaType && mediaType !== 'all') {
      imagesQuery = imagesQuery.eq('media_type', mediaType)
    }

    imagesQuery = imagesQuery.order('created_at', { ascending: false })

    const { data: images, error: imagesError } = await imagesQuery

    if (imagesError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    // Sign thumbnail URLs for images
    const imageItems = (images || []).filter((img) => img.media_type !== 'video')
    const thumbPaths = imageItems
      .map((img) => img.thumb_storage_path)
      .filter(Boolean) as string[]

    let signedThumbs = new Map<string, string>()
    if (thumbPaths.length > 0) {
      const { data: signed } = await supabase.storage
        .from('generated-images')
        .createSignedUrls(thumbPaths, SIGNED_URL_TTL_SECONDS)
      if (signed) {
        signedThumbs = new Map(
          signed
            .filter((item) => item?.signedUrl && item?.path)
            .map((item) => [item.path!, item.signedUrl])
        )
      }
    }

    // Sign video URLs
    const videoItems = (images || []).filter((img) => img.media_type === 'video')
    const videoPaths = videoItems
      .map((v) => v.storage_path)
      .filter(Boolean) as string[]

    let signedVideos = new Map<string, string>()
    if (videoPaths.length > 0) {
      const { data: signed } = await supabase.storage
        .from('generated-videos')
        .createSignedUrls(videoPaths, SIGNED_URL_TTL_SECONDS)
      if (signed) {
        signedVideos = new Map(
          signed
            .filter((item) => item?.signedUrl && item?.path)
            .map((item) => [item.path!, item.signedUrl])
        )
      }
    }

    const signedImages = (images || []).map((img) => ({
      ...img,
      public_url: img.media_type === 'video'
        ? (signedVideos.get(img.storage_path) ?? null)
        : null,
      preview_public_url: null,
      thumb_public_url: img.thumb_storage_path
        ? (signedThumbs.get(img.thumb_storage_path) ?? null)
        : null,
      prompt_template_id: img.job_id ? (jobTemplateMap.get(img.job_id) ?? null) : null,
    }))

    return NextResponse.json({ images: signedImages })
  } catch (err) {
    console.error('[Gallery] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
