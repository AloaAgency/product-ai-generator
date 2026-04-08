import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60
const MAX_BATCH_SIZE = 24

type SignedImageUrls = {
  signed_url: string | null
  download_url: string | null
  thumb_signed_url: string | null
  preview_signed_url: string | null
  expires_at: number
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { image_ids?: unknown } | null
    const imageIds = Array.isArray(body?.image_ids)
      ? body.image_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []

    const uniqueImageIds = Array.from(new Set(imageIds)).slice(0, MAX_BATCH_SIZE)
    if (uniqueImageIds.length === 0) {
      return NextResponse.json({ signed_urls: {} satisfies Record<string, SignedImageUrls> })
    }

    const supabase = createServiceClient()
    const { data: images, error } = await supabase
      .from(T.generated_images)
      .select('id, media_type, storage_path, thumb_storage_path, preview_storage_path')
      .in('id', uniqueImageIds)

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    const imageItems = (images || []).filter((img) => img.media_type !== 'video')
    const videoItems = (images || []).filter((img) => img.media_type === 'video')

    const imagePaths = Array.from(new Set(
      imageItems.flatMap((img) => [img.storage_path, img.thumb_storage_path, img.preview_storage_path].filter(Boolean) as string[])
    ))
    const videoPaths = Array.from(new Set(
      videoItems.flatMap((img) => [img.storage_path, img.thumb_storage_path].filter(Boolean) as string[])
    ))

    const [signedImageResult, signedVideoResult] = await Promise.all([
      imagePaths.length > 0
        ? supabase.storage.from('generated-images').createSignedUrls(imagePaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null }),
      videoPaths.length > 0
        ? supabase.storage.from('generated-videos').createSignedUrls(videoPaths, SIGNED_URL_TTL_SECONDS)
        : Promise.resolve({ data: null }),
    ])

    const signedImages = new Map<string, string>(
      (signedImageResult.data || [])
        .filter((item) => item?.signedUrl && item?.path)
        .map((item) => [item.path!, item.signedUrl])
    )
    const signedVideos = new Map<string, string>(
      (signedVideoResult.data || [])
        .filter((item) => item?.signedUrl && item?.path)
        .map((item) => [item.path!, item.signedUrl])
    )

    const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    const signedUrls: Record<string, SignedImageUrls> = {}

    for (const image of images || []) {
      if (image.media_type === 'video') {
        signedUrls[image.id] = {
          signed_url: image.storage_path ? (signedVideos.get(image.storage_path) ?? null) : null,
          download_url: null,
          thumb_signed_url: image.thumb_storage_path ? (signedVideos.get(image.thumb_storage_path) ?? null) : null,
          preview_signed_url: null,
          expires_at: expiresAt,
        }
        continue
      }

      signedUrls[image.id] = {
        signed_url: image.storage_path ? (signedImages.get(image.storage_path) ?? null) : null,
        download_url: null,
        thumb_signed_url: image.thumb_storage_path ? (signedImages.get(image.thumb_storage_path) ?? null) : null,
        preview_signed_url: image.preview_storage_path ? (signedImages.get(image.preview_storage_path) ?? null) : null,
        expires_at: expiresAt,
      }
    }

    return NextResponse.json({ signed_urls: signedUrls })
  } catch (err) {
    console.error('[ImagesSignedBatch] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
