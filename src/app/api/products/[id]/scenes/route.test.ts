import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { createServiceClientMock } = vi.hoisted(() => ({
  createServiceClientMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: createServiceClientMock,
}))

import { GET, POST } from './route'

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const IMAGE_ID = '22222222-2222-4222-8222-222222222222'

const postScene = (body: Record<string, unknown>, productId = PRODUCT_ID) =>
  POST(
    new NextRequest(`http://localhost/api/products/${productId}/scenes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: productId }) }
  )

describe('scene route request validation', () => {
  beforeEach(() => {
    createServiceClientMock.mockReset()
  })

  it('rejects malformed product and query ids before creating a database client', async () => {
    const postResponse = await postScene({ motion_prompt: 'Move' }, 'not-a-uuid')
    expect(postResponse.status).toBe(400)

    const getResponse = await GET(
      new NextRequest(`http://localhost/api/products/${PRODUCT_ID}/scenes?storyboard_id=not-a-uuid`),
      { params: Promise.resolve({ id: PRODUCT_ID }) }
    )
    expect(getResponse.status).toBe(400)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects non-string prompt fields before issuing a database query', async () => {
    const from = vi.fn()
    createServiceClientMock.mockReturnValue({ from })

    const response = await postScene({ motion_prompt: { nested: 'prompt' } })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'motion_prompt must be a string' })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects non-UUID frame references before issuing a database query', async () => {
    const from = vi.fn()
    createServiceClientMock.mockReturnValue({ from })

    const response = await postScene({
      motion_prompt: 'Move',
      start_frame_image_id: 'not-a-uuid',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid scene reference id' })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects frame ids that do not belong to the selected product', async () => {
    const frameQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
    }
    frameQuery.select.mockReturnValue(frameQuery)
    frameQuery.eq.mockReturnValue(frameQuery)
    frameQuery.in.mockResolvedValue({ data: [], error: null })
    const from = vi.fn(() => frameQuery)
    createServiceClientMock.mockReturnValue({ from })

    const response = await postScene({
      motion_prompt: 'Move',
      start_frame_image_id: IMAGE_ID,
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Frame images must belong to the selected product',
    })
    expect(frameQuery.eq).toHaveBeenCalledWith('product_id', PRODUCT_ID)
    expect(frameQuery.in).toHaveBeenCalledWith('id', [IMAGE_ID])
  })
})
