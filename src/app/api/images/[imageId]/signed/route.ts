import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const { imageId } = await params

  try {
    const supabase = createServiceClient()

    const { data: image, error } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('id', imageId)
      .single()

    if (error || !image) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 })
    }

    const bucket = image.media_type === 'video' ? 'generated-videos' : 'generated-images'

    const signPath = async (path: string | null) => {
      if (!path) return null
      const { data: signed, error: signedError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
      return signedError ? null : (signed?.signedUrl ?? null)
    }

    const [signedUrl, thumbSignedUrl, previewSignedUrl] = image.media_type === 'video'
      ? [await signPath(image.storage_path), null, null]
      : await Promise.all([
          signPath(image.storage_path),
          signPath(image.thumb_storage_path),
          signPath(image.preview_storage_path),
        ])

    return NextResponse.json({
      image_id: imageId,
      signed_url: signedUrl,
      thumb_signed_url: thumbSignedUrl,
      preview_signed_url: previewSignedUrl,
      expires_at: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
    })
  } catch (err) {
    console.error('[ImageSigned] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
