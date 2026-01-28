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

    if (jobIds.length === 0) {
      return NextResponse.json({ images: [] })
    }

    // Fetch generated images for those jobs
    let imagesQuery = supabase
      .from(T.generated_images)
      .select('*')
      .in('job_id', jobIds)

    if (approvalStatus) {
      imagesQuery = imagesQuery.eq('approval_status', approvalStatus)
    }

    imagesQuery = imagesQuery.order('created_at', { ascending: false })

    const { data: images, error: imagesError } = await imagesQuery

    if (imagesError) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    const thumbPaths = (images || [])
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

    const signedImages = (images || []).map((img) => ({
      ...img,
      public_url: null,
      preview_public_url: null,
      thumb_public_url: img.thumb_storage_path
        ? (signedThumbs.get(img.thumb_storage_path) ?? null)
        : null,
      prompt_template_id: jobTemplateMap.get(img.job_id) ?? null,
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
