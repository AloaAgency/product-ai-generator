import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id: productId, jobId } = await params

  try {
    const supabase = createServiceClient()

    // Fetch job
    const { data: job, error: jobError } = await supabase
      .from(T.generation_jobs)
      .select('*')
      .eq('id', jobId)
      .eq('product_id', productId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // Fetch generated images for this job
    const { data: images } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('job_id', jobId)
      .order('variation_number', { ascending: true })

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
    }))

    return NextResponse.json({ job, images: signedImages })
  } catch (err) {
    console.error('[JobStatus] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
