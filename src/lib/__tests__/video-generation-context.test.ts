import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { T } from '@/lib/db-tables'

const { createServiceClientMock, extractVideoThumbnailMock } = vi.hoisted(() => ({
  createServiceClientMock: vi.fn(),
  extractVideoThumbnailMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: createServiceClientMock,
}))

vi.mock('@/lib/image-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image-utils')>()
  return {
    ...actual,
    extractVideoThumbnail: extractVideoThumbnailMock,
  }
})

import { generateSceneVideo, VideoJobCancelledError } from '../video-generation'

type EnvPatch = Record<string, string | undefined>
type SupabaseError = { message: string }
type SceneFixture = {
  id: string
  product_id: string
  title: string | null
  motion_prompt: string | null
  generation_model: string | null
  start_frame_image_id: string | null
  end_frame_image_id: string | null
  video_resolution: string | null
  video_aspect_ratio: string | null
  video_duration_seconds: number | null
  video_fps: number | null
  video_generate_audio: boolean | null
}

async function withEnv(patch: EnvPatch, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function buildSceneFixture(overrides: Partial<SceneFixture> = {}): SceneFixture {
  return {
    id: 'scene-1',
    product_id: 'product-1',
    title: 'Launch shot',
    motion_prompt: 'Product spin',
    generation_model: 'ltx',
    start_frame_image_id: null,
    end_frame_image_id: null,
    video_resolution: '1920x1080',
    video_aspect_ratio: '16:9',
    video_duration_seconds: 8,
    video_fps: null,
    video_generate_audio: false,
    ...overrides,
  }
}

function createSupabaseMock(options: {
  scene?: SceneFixture | null
  sceneError?: SupabaseError | null
  product?: { project_id: string | null; global_style_settings: null } | null
  productError?: SupabaseError | null
  project?: { global_style_settings: null } | null
  projectError?: SupabaseError | null
  insertError?: SupabaseError | null
  jobStatuses?: string[]
  frames?: Array<{ id: string; storage_path: string | null; mime_type: string | null }>
  frameError?: SupabaseError | null
} = {}) {
  const sceneEqFilters: Array<[string, unknown]> = []
  const generatedImageInserts: Array<Record<string, unknown>> = []
  let sceneSelectColumns = ''

  const sceneQuery = {
    select: vi.fn((columns: string) => {
      sceneSelectColumns = columns
      return sceneQuery
    }),
    eq: vi.fn((field: string, value: unknown) => {
      sceneEqFilters.push([field, value])
      return sceneQuery
    }),
    single: vi.fn(async () => ({
      data: options.scene ?? null,
      error: options.sceneError ?? null,
    })),
  }

  const productQuery = {
    select: vi.fn(() => productQuery),
    eq: vi.fn(() => productQuery),
    single: vi.fn(async () => ({
      data: options.product ?? { project_id: null, global_style_settings: null },
      error: options.productError ?? null,
    })),
  }

  const projectQuery = {
    select: vi.fn(() => projectQuery),
    eq: vi.fn(() => projectQuery),
    single: vi.fn(async () => ({
      data: options.project ?? { global_style_settings: null },
      error: options.projectError ?? null,
    })),
  }

  const generatedImagesTable = {
    select: vi.fn(() => generatedImagesTable),
    in: vi.fn(async () => ({
      data: options.frames || [],
      error: options.frameError ?? null,
    })),
    insert: vi.fn((payload: Record<string, unknown>) => {
      generatedImageInserts.push(payload)
      return {
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: options.insertError ? null : { id: 'video-record', ...payload },
            error: options.insertError ?? null,
          })),
        })),
      }
    }),
  }

  const jobStatuses = [...(options.jobStatuses || [])]
  const generationJobQuery = {
    select: vi.fn(() => generationJobQuery),
    eq: vi.fn(() => generationJobQuery),
    single: vi.fn(async () => ({
      data: { status: jobStatuses.shift() || 'running' },
      error: null,
    })),
  }

  const upload = vi.fn(async () => ({ error: null }))
  const remove = vi.fn(async () => ({ error: null }))
  const storage = {
    from: vi.fn(() => ({ upload, remove })),
  }

  const client = {
    from: vi.fn((table: string) => {
      if (table === T.storyboard_scenes) return sceneQuery
      if (table === T.products) return productQuery
      if (table === T.projects) return projectQuery
      if (table === T.generated_images) return generatedImagesTable
      if (table === T.generation_jobs) return generationJobQuery
      throw new Error(`Unexpected table: ${table}`)
    }),
    storage,
  }

  return {
    client,
    generatedImageInserts,
    sceneEqFilters,
    upload,
    remove,
    get sceneSelectColumns() {
      return sceneSelectColumns
    },
  }
}

beforeEach(() => {
  createServiceClientMock.mockReset()
  extractVideoThumbnailMock.mockReset()
  extractVideoThumbnailMock.mockResolvedValue({
    buffer: Buffer.from('thumbnail'),
    mimeType: 'image/jpeg',
    extension: 'jpg',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateSceneVideo context loading', () => {
  it('scopes scene loading by product and records the generated video against that product', async () => {
    const supabase = createSupabaseMock({
      scene: buildSceneFixture(),
    })
    createServiceClientMock.mockReturnValue(supabase.client)
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('video'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    )

    await withEnv({ LTX_API_KEY: 'ltx-secret' }, async () => {
      const record = await generateSceneVideo('product-1', 'scene-1', 'ltx', 'job-1')

      expect(record).toMatchObject({ id: 'video-record' })
    })

    expect(supabase.sceneSelectColumns).toContain('product_id')
    expect(supabase.sceneEqFilters).toContainEqual(['id', 'scene-1'])
    expect(supabase.sceneEqFilters).toContainEqual(['product_id', 'product-1'])
    expect(supabase.client.from).not.toHaveBeenCalledWith(T.products)
    expect(supabase.generatedImageInserts[0]).toMatchObject({
      product_id: 'product-1',
      job_id: 'job-1',
      media_type: 'video',
      scene_id: 'scene-1',
    })
  })

  it('surfaces product settings lookup errors for Veo jobs before starting generation', async () => {
    const supabase = createSupabaseMock({
      scene: buildSceneFixture({
        generation_model: 'veo3',
        video_resolution: '1080p',
      }),
      product: null,
      productError: { message: 'database unavailable' },
    })
    createServiceClientMock.mockReturnValue(supabase.client)
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    await withEnv(
      {
        GOOGLE_AI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
      },
      async () => {
        await expect(
          generateSceneVideo('product-1', 'scene-1', 'veo3', 'job-1')
        ).rejects.toThrow(/Failed to load product settings: database unavailable/)
      }
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cleans up an uploaded video when cancellation wins the persistence race', async () => {
    const supabase = createSupabaseMock({
      scene: buildSceneFixture(),
      // Before provider request, after provider response, after video upload.
      jobStatuses: ['running', 'running', 'cancelled'],
    })
    createServiceClientMock.mockReturnValue(supabase.client)
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('video'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    )

    await withEnv({ LTX_API_KEY: 'ltx-secret' }, async () => {
      await expect(
        generateSceneVideo('product-1', 'scene-1', 'ltx', 'job-1')
      ).rejects.toThrow(VideoJobCancelledError)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(supabase.upload).toHaveBeenCalledTimes(1)
    expect(supabase.remove).toHaveBeenCalledWith([
      expect.stringMatching(/^products\/product-1\/scenes\/scene-1\/video-product-spin-\d+\.mp4$/),
    ])
    expect(extractVideoThumbnailMock).not.toHaveBeenCalled()
    expect(supabase.generatedImageInserts).toHaveLength(0)
  })

  it('fails before provider generation when a configured frame cannot be resolved', async () => {
    const supabase = createSupabaseMock({
      scene: buildSceneFixture({ start_frame_image_id: 'missing-frame' }),
      frames: [],
    })
    createServiceClientMock.mockReturnValue(supabase.client)
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('video'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    )

    await withEnv({ LTX_API_KEY: 'ltx-secret' }, async () => {
      await expect(
        generateSceneVideo('product-1', 'scene-1', 'ltx')
      ).rejects.toThrow(/Configured start frame image is unavailable/)
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(supabase.upload).not.toHaveBeenCalled()
    expect(supabase.generatedImageInserts).toHaveLength(0)
  })
})
