#!/usr/bin/env node
/**
 * One-time backfill script: generate WebP thumbnails for existing videos
 * that don't have thumb_storage_path set.
 *
 * Usage: node scripts/backfill-video-thumbs.mjs [--limit N]
 */

import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeFile, readFile, unlink } from 'fs/promises'
import sharp from 'sharp'
import { readFileSync } from 'fs'

// Parse .env.local manually
const envContent = readFileSync('.env.local', 'utf-8')
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE env vars in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Parse --limit flag
const limitArg = process.argv.find((a) => a.startsWith('--limit'))
const limitIdx = process.argv.indexOf('--limit')
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) || 50 : 50

function buildThumbnailPath(storagePath, extension) {
  const lastSlash = storagePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash)
  const fileName = lastSlash === -1 ? storagePath : storagePath.slice(lastSlash + 1)
  const baseName = fileName.replace(/\.[^/.]+$/, '')
  const suffix = `${baseName}.${extension}`
  return dir ? `${dir}/thumbs/${suffix}` : `thumbs/${suffix}`
}

async function extractVideoThumbnail(videoBuffer) {
  const id = randomUUID()
  const tmpVideo = join(tmpdir(), `vid-${id}.mp4`)
  const tmpFrame = join(tmpdir(), `frame-${id}.png`)

  try {
    await writeFile(tmpVideo, videoBuffer)
    execSync(`ffmpeg -y -ss 0.1 -i "${tmpVideo}" -frames:v 1 -update 1 "${tmpFrame}"`, {
      stdio: 'pipe',
    })
    const frameBuffer = await readFile(tmpFrame)
    const thumb = await sharp(frameBuffer)
      .resize({ width: 480, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    return { buffer: thumb, mimeType: 'image/webp', extension: 'webp' }
  } finally {
    await unlink(tmpVideo).catch(() => {})
    await unlink(tmpFrame).catch(() => {})
  }
}

async function main() {
  console.log(`Fetching up to ${LIMIT} videos without thumbnails...`)

  const { data: videos, error } = await supabase
    .from('prodai_generated_images')
    .select('id, storage_path')
    .eq('media_type', 'video')
    .is('thumb_storage_path', null)
    .order('created_at', { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error('DB query error:', error.message)
    process.exit(1)
  }

  if (!videos || videos.length === 0) {
    console.log('No videos without thumbnails found. Done!')
    return
  }

  console.log(`Found ${videos.length} videos to process.\n`)

  let success = 0
  let errors = 0

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i]
    const label = `[${i + 1}/${videos.length}] ${video.id}`

    try {
      process.stdout.write(`${label} downloading... `)
      const { data: videoData, error: dlErr } = await supabase.storage
        .from('generated-videos')
        .download(video.storage_path)

      if (dlErr || !videoData) {
        console.log(`FAIL (download: ${dlErr?.message})`)
        errors++
        continue
      }

      const videoBuffer = Buffer.from(await videoData.arrayBuffer())
      process.stdout.write(`extracting thumb... `)

      const thumb = await extractVideoThumbnail(videoBuffer)
      const thumbPath = buildThumbnailPath(video.storage_path, thumb.extension)

      process.stdout.write(`uploading... `)
      const { error: uploadErr } = await supabase.storage
        .from('generated-videos')
        .upload(thumbPath, thumb.buffer, { contentType: thumb.mimeType })

      if (uploadErr) {
        console.log(`FAIL (upload: ${uploadErr.message})`)
        errors++
        continue
      }

      const { error: updateErr } = await supabase
        .from('prodai_generated_images')
        .update({ thumb_storage_path: thumbPath })
        .eq('id', video.id)

      if (updateErr) {
        console.log(`FAIL (db: ${updateErr.message})`)
        errors++
        continue
      }

      console.log('OK')
      success++
    } catch (err) {
      console.log(`FAIL (${err.message})`)
      errors++
    }
  }

  console.log(`\nDone! ${success} success, ${errors} errors out of ${videos.length} total.`)

  // Check if there are more remaining
  const { count } = await supabase
    .from('prodai_generated_images')
    .select('id', { count: 'exact', head: true })
    .eq('media_type', 'video')
    .is('thumb_storage_path', null)

  if (count && count > 0) {
    console.log(`${count} videos still remaining. Run again to continue.`)
  }
}

main()
