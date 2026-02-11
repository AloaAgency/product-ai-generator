import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const { searchParams } = request.nextUrl
  const approvalStatus = searchParams.get('approval_status')
  const mediaType = searchParams.get('media_type')
  const productIdFilter = searchParams.get('product_id')

  try {
    const supabase = createServiceClient()

    // 1. Fetch all products for this project
    let productsQuery = supabase
      .from(T.products)
      .select('id, name')
      .eq('project_id', projectId)
      .order('name')

    if (productIdFilter) {
      productsQuery = productsQuery.eq('id', productIdFilter)
    }

    const { data: products, error: productsError } = await productsQuery
    if (productsError) {
      return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 })
    }
    if (!products || products.length === 0) {
      return NextResponse.json({ products: [] })
    }

    const productIds = products.map((p) => p.id)
    const productNameMap = new Map(products.map((p) => [p.id, p.name]))

    // 2. Fetch all generation_jobs for these products
    const { data: jobs } = await supabase
      .from(T.generation_jobs)
      .select('id, product_id, prompt_template_id')
      .in('product_id', productIds)

    const jobIds = (jobs || []).map((j) => j.id)
    const jobProductMap = new Map((jobs || []).map((j) => [j.id, j.product_id]))

    // 3. Fetch storyboard scenes for these products
    const { data: boards } = await supabase
      .from(T.storyboards)
      .select('id, product_id')
      .in('product_id', productIds)

    const boardIds = (boards || []).map((b) => b.id)
    const boardProductMap = new Map((boards || []).map((b) => [b.id, b.product_id]))

    let sceneIds: string[] = []
    const sceneProductMap = new Map<string, string>()

    if (boardIds.length > 0) {
      const { data: scenes } = await supabase
        .from(T.storyboard_scenes)
        .select('id, storyboard_id')
        .in('storyboard_id', boardIds)

      if (scenes) {
        sceneIds = scenes.map((s) => s.id)
        for (const scene of scenes) {
          const prodId = boardProductMap.get(scene.storyboard_id!)
          if (prodId) sceneProductMap.set(scene.id, prodId)
        }
      }
    }

    // 4. Fetch generated_images matching jobs OR scenes
    if (jobIds.length === 0 && sceneIds.length === 0) {
      return NextResponse.json({
        products: products.map((p) => ({ product_id: p.id, product_name: p.name, images: [] })),
      })
    }

    let imagesQuery = supabase
      .from(T.generated_images)
      .select('*')

    if (jobIds.length > 0 && sceneIds.length > 0) {
      imagesQuery = imagesQuery.or(
        `job_id.in.(${jobIds.join(',')}),scene_id.in.(${sceneIds.join(',')})`
      )
    } else if (jobIds.length > 0) {
      imagesQuery = imagesQuery.in('job_id', jobIds)
    } else {
      imagesQuery = imagesQuery.in('scene_id', sceneIds)
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

    // 5. Sign thumbnail + video URLs
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

    // 6. Group by product_id
    const productImageMap = new Map<string, typeof images>()
    for (const pid of productIds) {
      productImageMap.set(pid, [])
    }

    for (const img of images || []) {
      let prodId: string | undefined
      if (img.job_id) {
        prodId = jobProductMap.get(img.job_id)
      }
      if (!prodId && img.scene_id) {
        prodId = sceneProductMap.get(img.scene_id)
      }
      if (prodId && productImageMap.has(prodId)) {
        productImageMap.get(prodId)!.push(img)
      }
    }

    const result = products.map((p) => ({
      product_id: p.id,
      product_name: p.name,
      images: (productImageMap.get(p.id) || []).map((img) => ({
        ...img,
        public_url: img.media_type === 'video'
          ? (signedVideos.get(img.storage_path) ?? null)
          : null,
        preview_public_url: null,
        thumb_public_url: img.thumb_storage_path
          ? (signedThumbs.get(img.thumb_storage_path) ?? null)
          : null,
      })),
    }))

    // Filter out products with no images (unless product filter is set)
    const filtered = productIdFilter
      ? result
      : result.filter((p) => p.images.length > 0)

    return NextResponse.json({ products: filtered })
  } catch (err) {
    console.error('[ProjectGallery] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
