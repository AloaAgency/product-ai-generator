import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()

    const formData = await request.formData()
    const files = formData.getAll('files') as File[]

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    // Get current image count and max display_order
    const { data: existing } = await supabase
      .from(T.reference_images)
      .select('display_order')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: false })

    const existingCount = existing?.length ?? 0

    const MAX_REFERENCE_IMAGES = 14

    if (existingCount + files.length > MAX_REFERENCE_IMAGES) {
      return NextResponse.json(
        { error: `Maximum ${MAX_REFERENCE_IMAGES} reference images allowed per set. Currently ${existingCount}, trying to add ${files.length}.` },
        { status: 400 }
      )
    }

    let nextOrder = (existing?.[0]?.display_order ?? -1) + 1

    const results = []

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const extension = file.name.includes('.')
        ? `.${file.name.split('.').pop()?.toLowerCase()}`
        : ''
      const storageFileName = `${Date.now()}-${randomUUID()}${extension}`
      const storagePath = `products/${productId}/refs/${setId}/${storageFileName}`

      const { error: uploadError } = await supabase.storage
        .from('reference-images')
        .upload(storagePath, buffer, {
          contentType: file.type,
          upsert: true,
        })

      if (uploadError) {
        results.push({ file: file.name, error: uploadError.message })
        continue
      }

      const { data: record, error: dbError } = await supabase
        .from(T.reference_images)
        .insert({
          reference_set_id: setId,
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type,
          file_size: file.size,
          display_order: nextOrder++,
        })
        .select()
        .single()

      if (dbError) {
        results.push({ file: file.name, error: dbError.message })
      } else {
        results.push(record)
      }
    }

    return NextResponse.json(results, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { setId } = await params
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.reference_images)
      .select('*')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const paths = (data || [])
      .map((img) => img.storage_path)
      .filter(Boolean) as string[]

    let signedMap = new Map<string, string>()
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage
        .from('reference-images')
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      if (signed) {
        signedMap = new Map(
          signed
            .filter((item) => item?.signedUrl && item?.path)
            .map((item) => [item.path!, item.signedUrl])
        )
      }
    }

    const images = (data || []).map((img) => ({
      ...img,
      public_url: img.storage_path ? (signedMap.get(img.storage_path) ?? null) : null,
    }))

    return NextResponse.json(images)
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
