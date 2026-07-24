/**
 * Tests for PATCH/DELETE /api/images/[imageId] (src/app/api/images/[imageId]/route.ts)
 *
 * PATCH is the approval/notes endpoint; DELETE removes a single gallery item.
 * The high-value behaviours pinned here:
 *  - id and field validation runs before any database client is constructed
 *  - PATCH builds the update payload only from recognized fields ("no valid
 *    fields" is rejected instead of issuing an empty update)
 *  - DELETE picks the storage bucket from media_type (video files live in
 *    generated-videos; using the image bucket would orphan them)
 *  - DELETE still removes the DB record when storage deletion fails, so the
 *    gallery never shows rows whose files are half-gone
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

import { PATCH, DELETE } from './route'

const IMAGE_ID = '11111111-1111-4111-8111-111111111111'

const patchImage = (body: unknown, imageId = IMAGE_ID) =>
  PATCH(
    new NextRequest(`http://localhost/api/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ imageId }) }
  )

const deleteImage = (imageId = IMAGE_ID) =>
  DELETE(
    new NextRequest(`http://localhost/api/images/${imageId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ imageId }) }
  )

type ImageRow = {
  storage_path: string | null
  thumb_storage_path: string | null
  preview_storage_path: string | null
  media_type: string | null
}

function makePatchClient(updateResult: { data: unknown; error: unknown }) {
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({ single: () => Promise.resolve(updateResult) })),
    })),
  }))
  const from = vi.fn(() => ({ update }))
  return { client: { from }, update }
}

function makeDeleteClient(options: {
  image?: ImageRow | null
  fetchError?: unknown
  deleteError?: unknown
  storageError?: unknown
}) {
  const remove = vi.fn(() => Promise.resolve({ data: null, error: options.storageError ?? null }))
  const storageFrom = vi.fn(() => ({ remove }))
  const deleteEq = vi.fn(() => Promise.resolve({ error: options.deleteError ?? null }))
  const from = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: () =>
          Promise.resolve({ data: options.image ?? null, error: options.fetchError ?? null }),
      })),
    })),
    delete: vi.fn(() => ({ eq: deleteEq })),
  }))
  return { client: { from, storage: { from: storageFrom } }, storageFrom, remove, deleteEq }
}

beforeEach(() => {
  createServiceClientMock.mockReset()
})

describe('PATCH /api/images/[imageId] — validation', () => {
  it('rejects a malformed image id before creating a database client', async () => {
    const res = await patchImage({ approval_status: 'approved' }, 'not-a-uuid')
    // requireUuid throws inside the handler's try block, so the route answers
    // with its generic 500 — the important property is that Supabase is never
    // touched with the unvalidated id.
    expect(res.status).toBe(500)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects a body with no recognized fields', async () => {
    const res = await patchImage({ unknown_field: 'x' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'No valid fields to update' })
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects non-string notes', async () => {
    const res = await patchImage({ notes: 42 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'notes must be a string or null' })
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown approval status before creating a database client', async () => {
    const res = await patchImage({ approval_status: 'super-approved' })
    expect(res.status).toBe(500)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/images/[imageId] — update payload', () => {
  it('trims notes and passes approved status through to the update', async () => {
    const image = { id: IMAGE_ID, approval_status: 'approved', notes: 'looks great' }
    const { client, update } = makePatchClient({ data: image, error: null })
    createServiceClientMock.mockReturnValue(client)

    const res = await patchImage({ approval_status: 'approved', notes: '  looks great  ' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ image })
    expect(update).toHaveBeenCalledWith({ approval_status: 'approved', notes: 'looks great' })
  })

  it('allows clearing approval_status and notes with explicit nulls', async () => {
    const image = { id: IMAGE_ID, approval_status: null, notes: null }
    const { client, update } = makePatchClient({ data: image, error: null })
    createServiceClientMock.mockReturnValue(client)

    const res = await patchImage({ approval_status: null, notes: null })

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith({ approval_status: null, notes: null })
  })

  it('returns 404 when the image does not exist', async () => {
    const { client } = makePatchClient({ data: null, error: { message: 'no rows' } })
    createServiceClientMock.mockReturnValue(client)

    const res = await patchImage({ approval_status: 'rejected' })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Image not found' })
  })
})

describe('DELETE /api/images/[imageId]', () => {
  it('rejects a malformed image id before creating a database client', async () => {
    const res = await deleteImage('42; DROP TABLE prodai_generated_images')
    expect(res.status).toBe(500)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('returns 404 without touching storage when the record is missing', async () => {
    const { client, storageFrom, deleteEq } = makeDeleteClient({
      image: null,
      fetchError: { message: 'no rows' },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(404)
    expect(storageFrom).not.toHaveBeenCalled()
    expect(deleteEq).not.toHaveBeenCalled()
  })

  it('deletes image files from the generated-images bucket', async () => {
    const { client, storageFrom, remove } = makeDeleteClient({
      image: {
        storage_path: 'img/a.png',
        thumb_storage_path: 'img/a_thumb.png',
        preview_storage_path: null,
        media_type: 'image',
      },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(storageFrom).toHaveBeenCalledWith('generated-images')
    expect(remove).toHaveBeenCalledWith(['img/a.png', 'img/a_thumb.png'])
  })

  it('deletes video files from the generated-videos bucket', async () => {
    const { client, storageFrom, remove } = makeDeleteClient({
      image: {
        storage_path: 'vid/b.mp4',
        thumb_storage_path: 'vid/b_thumb.jpg',
        preview_storage_path: 'vid/b_preview.mp4',
        media_type: 'video',
      },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(200)
    expect(storageFrom).toHaveBeenCalledWith('generated-videos')
    expect(remove).toHaveBeenCalledWith(['vid/b.mp4', 'vid/b_thumb.jpg', 'vid/b_preview.mp4'])
  })

  it('skips the storage call entirely when the record has no stored files', async () => {
    const { client, storageFrom, deleteEq } = makeDeleteClient({
      image: {
        storage_path: null,
        thumb_storage_path: null,
        preview_storage_path: null,
        media_type: 'image',
      },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(200)
    expect(storageFrom).not.toHaveBeenCalled()
    expect(deleteEq).toHaveBeenCalledWith('id', IMAGE_ID)
  })

  it('still deletes the DB record and reports success when storage removal fails', async () => {
    const { client, deleteEq } = makeDeleteClient({
      image: {
        storage_path: 'img/a.png',
        thumb_storage_path: null,
        preview_storage_path: null,
        media_type: 'image',
      },
      storageError: new Error('bucket unavailable'),
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(deleteEq).toHaveBeenCalledWith('id', IMAGE_ID)
  })

  it('returns 500 when the DB record deletion fails', async () => {
    const { client } = makeDeleteClient({
      image: {
        storage_path: 'img/a.png',
        thumb_storage_path: null,
        preview_storage_path: null,
        media_type: 'image',
      },
      deleteError: new Error('constraint violation'),
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteImage()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to delete image record' })
  })
})
