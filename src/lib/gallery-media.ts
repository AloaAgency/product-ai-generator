import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { logger } from '@/lib/server-logger'

/**
 * Shared media-serving helpers for the API routes that return gallery/scene
 * assets. Signed-URL map building, the gallery column list, and the
 * per-record URL attachment were previously copy-pasted across eight route
 * handlers (both gallery routes, the batch signer, the job-status route, the
 * two scene-video routes, and the reference-image list) and had already
 * started to drift in small ways. Behaviour must stay identical between this
 * module and the routes that call it.
 */

/** How long signed media URLs stay valid. Shared by every route that signs
 *  storage paths so gallery, job-status, and scene views expire together. */
export const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

type SignedUrlEntry = {
  path: string | null
  signedUrl: string | null
} | null

/**
 * Convert the `createSignedUrls` result rows into a path → URL lookup,
 * dropping rows where either side is missing (an individual path can fail to
 * sign without failing the whole batch).
 */
export function toSignedUrlMap(entries: SignedUrlEntry[] | null | undefined): Map<string, string> {
  return new Map(
    (entries || []).flatMap((item) => (
      typeof item?.path === 'string' && item.path && typeof item.signedUrl === 'string' && item.signedUrl
        ? [[item.path, item.signedUrl] as const]
        : []
    ))
  )
}

/**
 * Sign a batch of storage paths in one round-trip and return a path → URL map.
 * Skips the network call entirely for an empty batch. A bulk failure is
 * surfaced via `error` (already-extracted message) so callers can decide
 * whether to log it — every route treats missing URLs as null rather than
 * failing the request.
 */
export async function createSignedUrlMap(
  supabase: ReturnType<typeof createServiceClient>,
  bucket: string,
  paths: string[],
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS
): Promise<{ map: Map<string, string>; error: string | null }> {
  if (paths.length === 0) {
    return { map: new Map(), error: null }
  }
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, ttlSeconds)
  return { map: toSignedUrlMap(data), error: error?.message ?? null }
}

/** The generated_images columns the gallery views actually render. */
export const GALLERY_IMAGE_SELECT = [
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

export type GalleryImageRecord = {
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

type GalleryPathSource = Pick<
  GalleryImageRecord,
  'storage_path' | 'thumb_storage_path' | 'preview_storage_path' | 'media_type'
>

/**
 * Collect the storage paths a gallery page needs signed, split by bucket.
 * Images sign their thumb + preview variants (falling back to the original
 * only when neither derivative exists); videos live in the generated-videos
 * bucket and only need their poster thumbnail here — playback URLs are signed
 * on demand by the per-image routes.
 */
export function collectGalleryMediaPaths(records: GalleryPathSource[]): {
  imagePaths: string[]
  videoPaths: string[]
} {
  const imageItems = records.filter((img) => img.media_type !== 'video')
  const thumbPaths = imageItems
    .map((img) => img.thumb_storage_path)
    .filter(Boolean) as string[]
  const previewPaths = imageItems
    .map((img) => img.preview_storage_path)
    .filter(Boolean) as string[]
  const fallbackOriginalPaths = imageItems
    .filter((img) => !img.thumb_storage_path && !img.preview_storage_path)
    .map((img) => img.storage_path)
    .filter(Boolean) as string[]

  const videoThumbPaths = records
    .filter((img) => img.media_type === 'video')
    .map((video) => video.thumb_storage_path)
    .filter(Boolean) as string[]

  return {
    imagePaths: Array.from(new Set([...thumbPaths, ...previewPaths, ...fallbackOriginalPaths])),
    videoPaths: Array.from(new Set(videoThumbPaths)),
  }
}

export type GallerySignedUrls = {
  public_url: string | null
  preview_public_url: string | null
  thumb_public_url: string | null
}

/**
 * Resolve the three public URL fields the gallery payload exposes for one
 * record. Videos never expose full/preview URLs from list views and their
 * thumbnails come from the video bucket's map.
 */
export function resolveGallerySignedUrls(
  img: GalleryPathSource,
  signedImages: Map<string, string>,
  signedVideos: Map<string, string>
): GallerySignedUrls {
  if (img.media_type === 'video') {
    return {
      public_url: null,
      preview_public_url: null,
      thumb_public_url: img.thumb_storage_path ? (signedVideos.get(img.thumb_storage_path) ?? null) : null,
    }
  }
  return {
    public_url: img.storage_path ? (signedImages.get(img.storage_path) ?? null) : null,
    preview_public_url: img.preview_storage_path ? (signedImages.get(img.preview_storage_path) ?? null) : null,
    thumb_public_url: img.thumb_storage_path ? (signedImages.get(img.thumb_storage_path) ?? null) : null,
  }
}

/**
 * Shared GET handler for the two identical scene-video listing routes
 * (`/api/products/[id]/scenes/[sceneId]/videos` and the storyboard-scoped
 * variant). Lists a scene's generated videos with signed playback URLs.
 */
export async function handleSceneVideosGet(sceneId: string, logPrefix: string): Promise<NextResponse> {
  try {
    const supabase = createServiceClient()

    const { data: videos, error } = await supabase
      .from(T.generated_images)
      .select('*')
      .eq('scene_id', sceneId)
      .eq('media_type', 'video')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error(`[${logPrefix} GET]`, error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const paths = (videos || []).map((v) => v.storage_path).filter(Boolean) as string[]
    const { map: signedMap } = await createSignedUrlMap(supabase, 'generated-videos', paths)

    const result = (videos || []).map((v) => ({
      ...v,
      public_url: v.storage_path ? (signedMap.get(v.storage_path) ?? null) : null,
    }))

    return NextResponse.json({ videos: result })
  } catch (err) {
    logger.error(`[${logPrefix}] Error:`, err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
