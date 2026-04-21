#!/usr/bin/env node

/**
 * Backfill script: generates 480px WebP thumbnails for all images missing them.
 * Reads Supabase credentials from .env.local, processes images in batches.
 *
 * Usage: node scripts/backfill-image-thumbs.mjs
 */

import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { dirname, basename, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env.local')
const envContent = readFileSync(envPath, 'utf-8')

function getEnv(key) {
  const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'))
  return match?.[1]?.trim() ?? null
}

const SUPABASE_URL = getEnv('NEXT_PUBLIC_SUPABASE_URL')
const SUPABASE_SERVICE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY')

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const TABLE = 'prodai_generated_images'
const BUCKET = 'generated-images'
const BATCH_SIZE = 20
const THUMB_WIDTH = 480
const THUMB_QUALITY = 72

function buildThumbPath(storagePath) {
  const dir = dirname(storagePath)
  const base = basename(storagePath).replace(/\.[^/.]+$/, '')
  return dir === '.' ? `thumbs/${base}.webp` : `${dir}/thumbs/${base}.webp`
}

async function createThumbnail(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer()
}

async function run() {
  // Count total missing
  const { count: totalMissing } = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('media_type', 'image')
    .is('thumb_storage_path', null)
    .not('storage_path', 'is', null)

  console.log(`Found ${totalMissing} images without thumbnails`)
  if (!totalMissing || totalMissing === 0) {
    console.log('Nothing to do!')
    return
  }

  let processed = 0
  let succeeded = 0
  let failed = 0

  while (true) {
    const { data: images, error } = await supabase
      .from(TABLE)
      .select('id, storage_path')
      .eq('media_type', 'image')
      .is('thumb_storage_path', null)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .limit(BATCH_SIZE)

    if (error) {
      console.error('Query error:', error.message)
      break
    }

    if (!images || images.length === 0) {
      break
    }

    console.log(`\nProcessing batch of ${images.length} (${processed}/${totalMissing} done so far)`)

    for (const image of images) {
      processed++
      const shortId = image.id.slice(0, 8)
      try {
        // Download
        const { data: fileData, error: dlErr } = await supabase.storage
          .from(BUCKET)
          .download(image.storage_path)

        if (dlErr || !fileData) {
          console.error(`  [${shortId}] Download failed: ${dlErr?.message}`)
          failed++
          // Mark with empty thumb path so we don't retry broken ones forever
          await supabase.from(TABLE).update({ thumb_storage_path: '' }).eq('id', image.id)
          continue
        }

        const buffer = Buffer.from(await fileData.arrayBuffer())
        const thumbBuffer = await createThumbnail(buffer)
        const thumbPath = buildThumbPath(image.storage_path)

        // Upload thumbnail
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(thumbPath, thumbBuffer, { contentType: 'image/webp', upsert: true })

        if (upErr) {
          console.error(`  [${shortId}] Upload failed: ${upErr.message}`)
          failed++
          continue
        }

        // Update DB
        const { error: updateErr } = await supabase
          .from(TABLE)
          .update({ thumb_storage_path: thumbPath })
          .eq('id', image.id)

        if (updateErr) {
          console.error(`  [${shortId}] DB update failed: ${updateErr.message}`)
          failed++
          continue
        }

        succeeded++
        if (succeeded % 10 === 0) {
          console.log(`  ... ${succeeded} thumbnails created`)
        }
      } catch (err) {
        console.error(`  [${shortId}] Error: ${err.message}`)
        failed++
      }
    }
  }

  console.log(`\nDone! Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}`)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
