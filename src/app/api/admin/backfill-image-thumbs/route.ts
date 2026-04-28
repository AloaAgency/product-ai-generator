import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { createThumbnail, buildThumbnailPath } from '@/lib/image-utils'
import { isAdminAuthorizedNode } from '@/lib/server-secrets'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 20

export async function POST(request: NextRequest) {
  if (!isAdminAuthorizedNode(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), 100)

    const supabase = createServiceClient()

    // Find images without thumbnails (exclude videos)
    const { data: images, error } = await supabase
      .from(T.generated_images)
      .select('id, storage_path')
      .eq('media_type', 'image')
      .is('thumb_storage_path', null)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[Admin BackfillImageThumbs]', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    if (!images || images.length === 0) {
      return NextResponse.json({
        message: 'No images without thumbnails found',
        total: 0,
        success: 0,
        errors: 0,
        results: [],
      })
    }

    let success = 0
    let errors = 0
    const results: Array<{ id: string; status: string; error?: string }> = []

    for (const image of images) {
      try {
        // Download the full-size image
        const { data: imageData, error: downloadErr } = await supabase.storage
          .from('generated-images')
          .download(image.storage_path)

        if (downloadErr || !imageData) {
          results.push({ id: image.id, status: 'error', error: `Download failed: ${downloadErr?.message}` })
          errors++
          continue
        }

        const imageBuffer = Buffer.from(await imageData.arrayBuffer())

        // Create thumbnail (480px WebP)
        const thumb = await createThumbnail(imageBuffer)
        const thumbPath = buildThumbnailPath(image.storage_path, thumb.extension)

        // Upload thumbnail
        const { error: uploadErr } = await supabase.storage
          .from('generated-images')
          .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })

        if (uploadErr) {
          // If already exists, try upsert
          if (uploadErr.message?.includes('already exists') || uploadErr.message?.includes('Duplicate')) {
            const { error: upsertErr } = await supabase.storage
              .from('generated-images')
              .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType, upsert: true })
            if (upsertErr) {
              results.push({ id: image.id, status: 'error', error: `Upload failed: ${upsertErr.message}` })
              errors++
              continue
            }
          } else {
            results.push({ id: image.id, status: 'error', error: `Upload failed: ${uploadErr.message}` })
            errors++
            continue
          }
        }

        // Update DB record
        const { error: updateErr } = await supabase
          .from(T.generated_images)
          .update({ thumb_storage_path: thumbPath })
          .eq('id', image.id)

        if (updateErr) {
          results.push({ id: image.id, status: 'error', error: `DB update failed: ${updateErr.message}` })
          errors++
          continue
        }

        results.push({ id: image.id, status: 'ok' })
        success++
      } catch (err) {
        results.push({ id: image.id, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' })
        errors++
      }
    }

    // Count remaining images without thumbnails
    const { count: remaining } = await supabase
      .from(T.generated_images)
      .select('id', { count: 'exact', head: true })
      .eq('media_type', 'image')
      .is('thumb_storage_path', null)
      .not('storage_path', 'is', null)

    return NextResponse.json({
      total: images.length,
      success,
      errors,
      remaining: remaining ?? 0,
      results,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
