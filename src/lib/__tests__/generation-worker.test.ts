import { beforeEach, describe, expect, it, vi } from 'vitest'

type QueryResponse = {
  table: string
  type: 'select-single' | 'select-maybeSingle' | 'update-maybeSingle' | 'select-order' | 'insert'
  data?: unknown
  error?: { message: string } | null
}

type StorageResponse = {
  bucket: string
  type: 'upload' | 'download'
  data?: unknown
  error?: { message: string } | null
}

const serviceClientState = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof createMockSupabase>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => {
    if (!serviceClientState.current) {
      throw new Error('createServiceClient called without a configured mock')
    }
    return serviceClientState.current
  }),
}))

vi.mock('@/lib/gemini', () => ({
  generateGeminiImage: vi.fn(),
}))

vi.mock('@/lib/video-generation', () => ({
  generateSceneVideo: vi.fn(),
}))

vi.mock('@/lib/image-utils', () => ({
  buildImageStoragePath: vi.fn(() => 'products/product-1/jobs/job-1/gen-01.png'),
  buildPreviewPath: vi.fn(() => 'products/product-1/jobs/job-1/previews/gen-01.webp'),
  buildThumbnailPath: vi.fn(() => 'products/product-1/jobs/job-1/thumbs/gen-01.webp'),
  createPreview: vi.fn(async () => ({
    buffer: Buffer.from('preview'),
    mimeType: 'image/webp',
    extension: 'webp',
  })),
  createThumbnail: vi.fn(async () => ({
    buffer: Buffer.from('thumb'),
    mimeType: 'image/webp',
    extension: 'webp',
  })),
  resolveExtension: vi.fn(() => 'png'),
  slugify: vi.fn(() => 'prompt'),
}))

function createMockSupabase(
  queryResponses: QueryResponse[],
  storageResponses: StorageResponse[] = []
) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const queryQueue = [...queryResponses]
  const storageQueue = [...storageResponses]

  function nextQuery(table: string, type: QueryResponse['type']) {
    const next = queryQueue.shift()
    if (!next) {
      throw new Error(`Unexpected ${type} query for ${table}`)
    }
    expect(next.table).toBe(table)
    expect(next.type).toBe(type)
    return {
      data: next.data ?? null,
      error: next.error ?? null,
    }
  }

  function nextStorage(bucket: string, type: StorageResponse['type']) {
    const next = storageQueue.shift()
    if (!next) {
      throw new Error(`Unexpected ${type} storage call for ${bucket}`)
    }
    expect(next.bucket).toBe(bucket)
    expect(next.type).toBe(type)
    return {
      data: next.data ?? null,
      error: next.error ?? null,
    }
  }

  const storage = {
    from(bucket: string) {
      return {
        upload: vi.fn(async () => nextStorage(bucket, 'upload')),
        download: vi.fn(async () => nextStorage(bucket, 'download')),
      }
    },
  }

  const supabase = {
    updates,
    storage,
    from(table: string) {
      const state: {
        mode: 'select' | 'update' | 'insert' | null
        updates?: Record<string, unknown>
      } = { mode: null }
      const builder = {
        select(_columns?: string) {
          if (state.mode !== 'update') {
            state.mode = 'select'
          }
          return builder
        },
        update(values: Record<string, unknown>) {
          state.mode = 'update'
          state.updates = values
          updates.push({ table, values })
          return builder
        },
        insert(values: Record<string, unknown>) {
          state.mode = 'insert'
          return Promise.resolve(nextQuery(table, 'insert'))
        },
        eq() {
          return builder
        },
        in() {
          return builder
        },
        order() {
          return Promise.resolve(nextQuery(table, 'select-order'))
        },
        maybeSingle() {
          if (state.mode === 'update') {
            return Promise.resolve(nextQuery(table, 'update-maybeSingle'))
          }
          return Promise.resolve(nextQuery(table, 'select-maybeSingle'))
        },
        single() {
          return Promise.resolve(nextQuery(table, 'select-single'))
        },
      }

      return builder
    },
  }

  return supabase
}

describe('processGenerationJob', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    serviceClientState.current = null
  })

  it('marks a claimed image job as failed when required job data is missing', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 0, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: {
          id: jobId,
          product_id: 'product-1',
          prompt_template_id: null,
          reference_set_id: null,
          texture_set_id: null,
          product_image_count: null,
          texture_image_count: null,
          final_prompt: 'Prompt',
          variation_count: 1,
          resolution: '2K',
          aspect_ratio: '16:9',
          status: 'running',
          completed_count: 0,
          failed_count: 0,
          error_message: null,
          generation_model: null,
          job_type: 'image',
          scene_id: null,
          source_image_id: null,
        },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: { id: jobId },
      },
    ])

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).rejects.toThrow('Image generation job missing reference_set_id')
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      status: 'failed',
      failed_count: 1,
      error_message: 'Image generation job missing reference_set_id',
    })
  })

  it('fails the job when generated image uploads do not persist successfully', async () => {
    const jobId = '22222222-2222-4222-8222-222222222222'
    serviceClientState.current = createMockSupabase(
      [
        {
          table: 'prodai_generation_jobs',
          type: 'select-single',
          data: { id: jobId, status: 'pending', completed_count: 0, failed_count: 0 },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'update-maybeSingle',
          data: {
            id: jobId,
            product_id: 'product-1',
            prompt_template_id: null,
            reference_set_id: 'refs-1',
            texture_set_id: null,
            product_image_count: null,
            texture_image_count: null,
            final_prompt: 'Prompt',
            variation_count: 1,
            resolution: '2K',
            aspect_ratio: '16:9',
            status: 'running',
            completed_count: 0,
            failed_count: 0,
            error_message: null,
            generation_model: null,
            job_type: 'image',
            scene_id: null,
            source_image_id: null,
          },
        },
        {
          table: 'prodai_products',
          type: 'select-single',
          data: { project_id: null, global_style_settings: null },
        },
        {
          table: 'prodai_reference_images',
          type: 'select-order',
          data: [],
        },
        {
          table: 'prodai_generation_jobs',
          type: 'select-single',
          data: { status: 'running' },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'update-maybeSingle',
          data: { id: jobId },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'update-maybeSingle',
          data: { id: jobId },
        },
      ],
      [
        {
          bucket: 'generated-images',
          type: 'upload',
          error: { message: 'bucket down' },
        },
        {
          bucket: 'generated-images',
          type: 'upload',
          data: {},
        },
        {
          bucket: 'generated-images',
          type: 'upload',
          data: {},
        },
      ]
    )

    const { generateGeminiImage } = await import('@/lib/gemini')
    vi.mocked(generateGeminiImage).mockResolvedValue({
      mimeType: 'image/png',
      base64Data: Buffer.from('image').toString('base64'),
      requestId: 'req-1',
      raw: {},
    })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 0,
      failed: 1,
      status: 'failed',
    })
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      status: 'failed',
      failed_count: 1,
      error_message: 'Failed to upload generated image: bucket down',
    })
  })
})
