import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MAX_REFERENCE_IMAGES = 14

type UploadRequestItem = {
  name: string
  type: string
  size: number
  clientId: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; setId: string }> }
) {
  try {
    const { id: productId, setId } = await params
    const supabase = createServiceClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }
    const files = (body?.files || []) as UploadRequestItem[]

    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    for (const file of files) {
      if (!file || typeof file !== 'object') {
        return NextResponse.json({ error: 'Each file entry must be an object' }, { status: 400 })
      }
      if (typeof file.name !== 'string' || !file.name) {
        return NextResponse.json({ error: 'Each file entry must have a name' }, { status: 400 })
      }
      if (typeof file.type !== 'string') {
        return NextResponse.json({ error: 'Each file entry must have a type' }, { status: 400 })
      }
      if (typeof file.size !== 'number') {
        return NextResponse.json({ error: 'Each file entry must have a numeric size' }, { status: 400 })
      }
    }

    const { data: existing } = await supabase
      .from(T.reference_images)
      .select('display_order')
      .eq('reference_set_id', setId)
      .order('display_order', { ascending: false })

    const existingCount = existing?.length ?? 0
    if (existingCount + files.length > MAX_REFERENCE_IMAGES) {
      return NextResponse.json(
        {
          error: `Maximum ${MAX_REFERENCE_IMAGES} reference images allowed per set. Currently ${existingCount}, trying to add ${files.length}.`,
        },
        { status: 400 }
      )
    }

    let nextOrder = (existing?.[0]?.display_order ?? -1) + 1
    const results = []

    for (const file of files) {
      const extension = file.name.includes('.')
        ? `.${file.name.split('.').pop()?.toLowerCase()}`
        : ''
      const storageFileName = `${Date.now()}-${randomUUID()}${extension}`
      const storagePath = `products/${productId}/refs/${setId}/${storageFileName}`

      const { data, error } = await supabase.storage
        .from('reference-images')
        .createSignedUploadUrl(storagePath, { upsert: true })

      if (error || !data?.signedUrl) {
        results.push({ clientId: file.clientId, error: error?.message || 'Failed to sign upload' })
        continue
      }

      results.push({
        clientId: file.clientId,
        signedUrl: data.signedUrl,
        storage_path: storagePath,
        file_name: file.name,
        mime_type: file.type,
        file_size: file.size,
        display_order: nextOrder++,
      })
    }

    return NextResponse.json(results, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
