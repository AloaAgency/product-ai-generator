import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { requireUuid } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const { imageId } = await params

  try {
    const sanitizedImageId = requireUuid(imageId, 'image id')
    const supabase = createServiceClient()

    const { data: image, error } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('id', sanitizedImageId)
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

    const signDownloadPath = async (path: string | null) => {
      if (!path) return null
      const fileName = path.split('/').pop() || undefined
      const { data: signed, error: signedError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS, { download: fileName || true })
      return signedError ? null : (signed?.signedUrl ?? null)
    }

    // Videos only need the play + download URLs, but those two storage calls are
    // independent — sign them together instead of awaiting one after the other.
    const [signedUrl, thumbSignedUrl, previewSignedUrl, downloadUrl] = image.media_type === 'video'
      ? await Promise.all([
          signPath(image.storage_path),
          Promise.resolve<string | null>(null),
          Promise.resolve<string | null>(null),
          signDownloadPath(image.storage_path),
        ])
      : await Promise.all([
          signPath(image.storage_path),
          signPath(image.thumb_storage_path),
          signPath(image.preview_storage_path),
          signDownloadPath(image.storage_path),
        ])

    return NextResponse.json({
      image_id: sanitizedImageId,
      signed_url: signedUrl,
      thumb_signed_url: thumbSignedUrl,
      preview_signed_url: previewSignedUrl,
      download_url: downloadUrl,
      expires_at: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
    })
  } catch (err) {
    logger.error('[ImageSigned] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
