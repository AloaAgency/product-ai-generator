/**
 * Tests for POST /api/images/bulk-delete (src/app/api/images/bulk-delete/route.ts)
 *
 * This is a destructive, service-role endpoint. The tests pin down the
 * behaviours where a regression would silently lose or orphan user data:
 *  - input validation happens before any database client is constructed
 *  - duplicate ids are deduped before the 200-item cap and the DB queries
 *  - storage paths are routed to the correct bucket per media_type (video
 *    files live in generated-videos — deleting them from generated-images
 *    would no-op and leave orphaned files)
 *  - a storage deletion failure does not abort the DB record deletion
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { createServiceClientMock } = vi.hoisted(() => ({
  createServiceClientMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: createServiceClientMock,
}))

vi.mock('@/lib/server-logger', () => {
  const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  return { logger: noopLogger, createLogger: () => noopLogger }
})

import { POST } from './route'

/** Deterministic valid v4-shaped UUIDs: uuid(1), uuid(2), ... */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type ImageRow = {
  storage_path: string | null
  thumb_storage_path: string | null
  preview_storage_path: string | null
  media_type: string | null
}

function makeSupabase(options: {
  images?: ImageRow[]
  fetchError?: unknown
  deleteError?: unknown
  imageRemoveError?: unknown
  videoRemoveError?: unknown
} = {}) {
  const selectIn = vi.fn(() =>
    Promise.resolve({ data: options.images ?? [], error: options.fetchError ?? null })
  )
  const deleteIn = vi.fn(() => Promise.resolve({ error: options.deleteError ?? null }))
  const from = vi.fn(() => ({
    select: vi.fn(() => ({ in: selectIn })),
    delete: vi.fn(() => ({ in: deleteIn })),
  }))
  const imageRemove = vi.fn(() =>
    Promise.resolve({ data: null, error: options.imageRemoveError ?? null })
  )
  const videoRemove = vi.fn(() =>
    Promise.resolve({ data: null, error: options.videoRemoveError ?? null })
  )
  const storageFrom = vi.fn((bucket: string) => ({
    remove: bucket === 'generated-videos' ? videoRemove : imageRemove,
  }))

  const client = { from, storage: { from: storageFrom } }
  return { client, from, selectIn, deleteIn, imageRemove, videoRemove, storageFrom }
}

const postBulkDelete = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/images/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  createServiceClientMock.mockReset()
})

describe('POST /api/images/bulk-delete — input validation', () => {
  it.each([
    ['missing imageIds', {}],
    ['non-array imageIds', { imageIds: 'abc' }],
    ['empty array', { imageIds: [] }],
  ])('rejects %s with 400 before creating a database client', async (_label, body) => {
    const res = await postBulkDelete(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'imageIds must be a non-empty array' })
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/images/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
    )
    expect(res.status).toBe(400)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects a non-UUID image id without creating a database client', async () => {
    const res = await postBulkDelete({ imageIds: [uuid(1), '../../etc/passwd'] })
    // sanitizeUuidArray throws, so the request never reaches Supabase; the
    // outer catch converts the throw into the generic 500 response.
    expect(res.status).toBe(500)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects more than 200 unique ids with 400 before creating a database client', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => uuid(i + 1))
    const res = await postBulkDelete({ imageIds: ids })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/more than 200 images/)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('dedupes duplicate ids so 400 duplicates of 2 unique ids pass the cap', async () => {
    const { client, selectIn } = makeSupabase({ images: [] })
    createServiceClientMock.mockReturnValue(client)

    const ids = Array.from({ length: 400 }, (_, i) => uuid((i % 2) + 1))
    const res = await postBulkDelete({ imageIds: ids })

    expect(res.status).toBe(200)
    expect(selectIn).toHaveBeenCalledWith('id', [uuid(1), uuid(2)])
  })
})

describe('POST /api/images/bulk-delete — deletion behaviour', () => {
  it('returns deleted: 0 without touching storage when no records match', async () => {
    const { client, storageFrom, deleteIn } = makeSupabase({ images: [] })
    createServiceClientMock.mockReturnValue(client)

    const res = await postBulkDelete({ imageIds: [uuid(1)] })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 0 })
    expect(storageFrom).not.toHaveBeenCalled()
    expect(deleteIn).not.toHaveBeenCalled()
  })

  it('routes image paths to generated-images and video paths to generated-videos', async () => {
    const { client, imageRemove, videoRemove } = makeSupabase({
      images: [
        {
          storage_path: 'img/a.png',
          thumb_storage_path: 'img/a_thumb.png',
          preview_storage_path: null,
          media_type: 'image',
        },
        {
          storage_path: 'vid/b.mp4',
          thumb_storage_path: 'vid/b_thumb.jpg',
          preview_storage_path: 'vid/b_preview.mp4',
          media_type: 'video',
        },
      ],
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postBulkDelete({ imageIds: [uuid(1), uuid(2)] })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 2 })
    expect(imageRemove).toHaveBeenCalledWith(['img/a.png', 'img/a_thumb.png'])
    expect(videoRemove).toHaveBeenCalledWith(['vid/b.mp4', 'vid/b_thumb.jpg', 'vid/b_preview.mp4'])
  })

  it('treats records without media_type as images (legacy rows)', async () => {
    const { client, imageRemove, videoRemove } = makeSupabase({
      images: [
        {
          storage_path: 'img/legacy.png',
          thumb_storage_path: null,
          preview_storage_path: null,
          media_type: null,
        },
      ],
    })
    createServiceClientMock.mockReturnValue(client)

    await postBulkDelete({ imageIds: [uuid(1)] })

    expect(imageRemove).toHaveBeenCalledWith(['img/legacy.png'])
    expect(videoRemove).not.toHaveBeenCalled()
  })

  it('still deletes DB records and reports success when storage removal fails', async () => {
    const { client, deleteIn } = makeSupabase({
      images: [
        {
          storage_path: 'img/a.png',
          thumb_storage_path: null,
          preview_storage_path: null,
          media_type: 'image',
        },
      ],
      imageRemoveError: new Error('bucket unavailable'),
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postBulkDelete({ imageIds: [uuid(1)] })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 1 })
    expect(deleteIn).toHaveBeenCalledWith('id', [uuid(1)])
  })

  it('returns 500 when the image fetch fails', async () => {
    const { client, deleteIn } = makeSupabase({ fetchError: new Error('db down') })
    createServiceClientMock.mockReturnValue(client)

    const res = await postBulkDelete({ imageIds: [uuid(1)] })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch images' })
    expect(deleteIn).not.toHaveBeenCalled()
  })

  it('returns 500 when the DB record deletion fails', async () => {
    const { client } = makeSupabase({
      images: [
        {
          storage_path: 'img/a.png',
          thumb_storage_path: null,
          preview_storage_path: null,
          media_type: 'image',
        },
      ],
      deleteError: new Error('constraint violation'),
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postBulkDelete({ imageIds: [uuid(1)] })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to delete image records' })
  })
})
