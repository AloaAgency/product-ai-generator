import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function createImageJobRecord(jobId: string, overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  }
}

function createVideoJobRecord(jobId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    product_id: 'product-1',
    prompt_template_id: null,
    reference_set_id: null,
    texture_set_id: null,
    product_image_count: null,
    texture_image_count: null,
    final_prompt: 'Prompt',
    variation_count: 1,
    resolution: '1080p',
    aspect_ratio: '16:9',
    status: 'running',
    completed_count: 0,
    failed_count: 0,
    error_message: null,
    generation_model: 'veo-3',
    job_type: 'video',
    scene_id: 'scene-1',
    source_image_id: null,
    ...overrides,
  }
}

function createDownloadPayload(contents: string) {
  return {
    arrayBuffer: async () => Buffer.from(contents),
  }
}

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
        select(columns?: string) {
          void columns
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
          void values
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
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
    serviceClientState.current = null
    delete process.env.GENERATION_VARIATION_RETRIES
    delete process.env.GENERATION_RETRY_BASE_MS
    delete process.env.GENERATION_VARIATION_TIMEOUT_MS
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns running jobs without reclaiming them', async () => {
    const jobId = '00000000-0000-4000-8000-000000000000'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'running', completed_count: 2, failed_count: 1 },
      },
    ])

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 0,
      completed: 2,
      failed: 1,
      status: 'running',
    })
    expect(serviceClientState.current?.updates).toHaveLength(0)
  })

  it('returns the latest job state when another worker claims the pending job first', async () => {
    const jobId = '12345678-1234-4234-8234-123456789012'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 1, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: null,
      },
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { status: 'running', completed_count: 1, failed_count: 0 },
      },
    ])

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 0,
      completed: 1,
      failed: 0,
      status: 'running',
    })
    expect(serviceClientState.current?.updates).toHaveLength(1)
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
          data: createImageJobRecord(jobId, { reference_set_id: null }),
        },
        {
          table: 'prodai_generation_jobs',
          type: 'select-maybeSingle',
          data: { completed_count: 0, failed_count: 0 },
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
          data: createImageJobRecord(jobId),
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

  it('does not silently ignore progress persistence failures', async () => {
    const jobId = '33333333-3333-4333-8333-333333333333'
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
          data: createImageJobRecord(jobId),
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
          table: 'prodai_generated_images',
          type: 'insert',
          data: {},
        },
        {
          table: 'prodai_generation_jobs',
          type: 'update-maybeSingle',
          error: { message: 'write conflict' },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'select-maybeSingle',
          data: { completed_count: 1, failed_count: 0 },
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
          data: {},
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
      requestId: 'req-2',
      raw: {},
    })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).rejects.toThrow('Failed to persist generation job progress: write conflict')
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      completed_count: 1,
      status: 'failed',
      failed_count: 1,
      error_message: 'Failed to persist generation job progress: write conflict',
    })
  })

  it('finalizes claimed image jobs with no remaining variations without loading resources', async () => {
    const jobId = '12121212-1212-4212-8212-121212121212'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 1, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: createImageJobRecord(jobId, {
          variation_count: 1,
          completed_count: 1,
        }),
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: { id: jobId },
      },
    ])

    const { generateGeminiImage } = await import('@/lib/gemini')
    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 0,
      completed: 1,
      failed: 0,
      status: 'completed',
    })
    expect(generateGeminiImage).not.toHaveBeenCalled()
    expect(serviceClientState.current?.updates).toHaveLength(2)
  })

  it('retries retriable image generation errors and completes the job after a later success', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444'
    process.env.GENERATION_VARIATION_RETRIES = '1'
    process.env.GENERATION_RETRY_BASE_MS = '1'
    vi.spyOn(Math, 'random').mockReturnValue(0)

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
          data: createImageJobRecord(jobId),
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
          table: 'prodai_generated_images',
          type: 'insert',
          data: {},
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
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
      ]
    )

    const { generateGeminiImage } = await import('@/lib/gemini')
    vi.mocked(generateGeminiImage)
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce({
        mimeType: 'image/png',
        base64Data: Buffer.from('image').toString('base64'),
        requestId: 'req-retry',
        raw: {},
      })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 1,
      failed: 0,
      status: 'completed',
    })
    expect(generateGeminiImage).toHaveBeenCalledTimes(2)
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      status: 'completed',
      completed_count: 1,
      failed_count: 0,
    })
  })

  it('uses the project Gemini key and sends source plus limited reference images to Gemini', async () => {
    const jobId = '55555555-5555-4555-8555-555555555555'
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
          data: createImageJobRecord(jobId, {
            texture_set_id: 'texture-1',
            product_image_count: 1,
            texture_image_count: 1,
            source_image_id: 'source-1',
          }),
        },
        {
          table: 'prodai_products',
          type: 'select-single',
          data: { project_id: 'project-1', global_style_settings: null },
        },
        {
          table: 'prodai_reference_images',
          type: 'select-order',
          data: [
            { id: 'ref-1', reference_set_id: 'refs-1', storage_path: 'products/ref-1.png', mime_type: 'image/png', display_order: 1 },
            { id: 'ref-2', reference_set_id: 'refs-1', storage_path: 'products/ref-2.png', mime_type: 'image/png', display_order: 2 },
          ],
        },
        {
          table: 'prodai_reference_images',
          type: 'select-order',
          data: [
            { id: 'tex-1', reference_set_id: 'texture-1', storage_path: 'textures/tex-1.png', mime_type: 'image/png', display_order: 1 },
          ],
        },
        {
          table: 'prodai_generated_images',
          type: 'select-maybeSingle',
          data: { storage_path: 'generated/source.png', mime_type: 'image/png' },
        },
        {
          table: 'prodai_projects',
          type: 'select-single',
          data: { global_style_settings: { gemini_api_key: 'project-key' } },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'select-single',
          data: { status: 'running' },
        },
        {
          table: 'prodai_generated_images',
          type: 'insert',
          data: {},
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
        { bucket: 'generated-images', type: 'download', data: createDownloadPayload('source') },
        { bucket: 'reference-images', type: 'download', data: createDownloadPayload('product-ref') },
        { bucket: 'reference-images', type: 'download', data: createDownloadPayload('texture-ref') },
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
      ]
    )

    const { generateGeminiImage } = await import('@/lib/gemini')
    vi.mocked(generateGeminiImage).mockResolvedValue({
      mimeType: 'image/png',
      base64Data: Buffer.from('image').toString('base64'),
      requestId: 'req-project-key',
      raw: {},
    })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 1,
      failed: 0,
      status: 'completed',
    })

    expect(generateGeminiImage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'project-key',
      referenceImages: [
        { mimeType: 'image/png', base64: Buffer.from('source').toString('base64') },
        { mimeType: 'image/png', base64: Buffer.from('product-ref').toString('base64') },
        { mimeType: 'image/png', base64: Buffer.from('texture-ref').toString('base64') },
      ],
    }))
  })

  it('stops before the next variation after the job is cancelled during status refresh', async () => {
    const jobId = '66666666-6666-4666-8666-666666666666'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))

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
          data: createImageJobRecord(jobId, { variation_count: 2 }),
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
          table: 'prodai_generated_images',
          type: 'insert',
          data: {},
        },
        {
          table: 'prodai_generation_jobs',
          type: 'update-maybeSingle',
          data: { id: jobId },
        },
        {
          table: 'prodai_generation_jobs',
          type: 'select-single',
          data: { status: 'cancelled' },
        },
      ],
      [
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
      ]
    )

    const { generateGeminiImage } = await import('@/lib/gemini')
    vi.mocked(generateGeminiImage).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2025-01-01T00:00:04.000Z'))
      return {
        mimeType: 'image/png',
        base64Data: Buffer.from('image').toString('base64'),
        requestId: 'req-cancelled',
        raw: {},
      }
    })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId, { batchSize: 2, parallelism: 1 })).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 1,
      failed: 0,
      status: 'cancelled',
    })

    expect(generateGeminiImage).toHaveBeenCalledTimes(1)
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      completed_count: 1,
      failed_count: 0,
    })
  })

  it('leaves partially processed image jobs pending so another worker tick can continue them', async () => {
    const jobId = '77777777-7777-4777-8777-777777777777'
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
          data: createImageJobRecord(jobId, { variation_count: 3 }),
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
          table: 'prodai_generated_images',
          type: 'insert',
          data: {},
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
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
        { bucket: 'generated-images', type: 'upload', data: {} },
      ]
    )

    const { generateGeminiImage } = await import('@/lib/gemini')
    vi.mocked(generateGeminiImage).mockResolvedValue({
      mimeType: 'image/png',
      base64Data: Buffer.from('image').toString('base64'),
      requestId: 'req-partial',
      raw: {},
    })

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId, { batchSize: 1, parallelism: 1 })).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 1,
      failed: 0,
      status: 'pending',
    })

    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      status: 'pending',
      completed_count: 1,
      failed_count: 0,
    })
  })

  it('marks video jobs completed after successful generation', async () => {
    const jobId = '88888888-8888-4888-8888-888888888888'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 0, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: createVideoJobRecord(jobId),
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: { id: jobId },
      },
    ])

    const { generateSceneVideo } = await import('@/lib/video-generation')
    vi.mocked(generateSceneVideo).mockResolvedValue(undefined)

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).resolves.toMatchObject({
      jobId,
      processed: 1,
      completed: 1,
      failed: 0,
      status: 'completed',
    })
    expect(generateSceneVideo).toHaveBeenCalledWith('product-1', 'scene-1', 'veo-3', jobId)
    expect(serviceClientState.current?.updates.at(-1)?.values).toMatchObject({
      status: 'completed',
      completed_count: 1,
    })
  })

  it('sanitizes video generation failures before persisting them', async () => {
    const jobId = '99999999-9999-4999-8999-999999999999'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 0, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: createVideoJobRecord(jobId),
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: { id: jobId },
      },
    ])

    const { generateSceneVideo } = await import('@/lib/video-generation')
    vi.mocked(generateSceneVideo).mockRejectedValue(
      new Error('upstream failed with Bearer super-secret-token')
    )

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
      error_message: 'upstream failed with Bearer [redacted]',
    })
  })

  it('fails when it cannot load the latest job state after another worker claims the job first', async () => {
    const jobId = '13131313-1313-4313-8313-131313131313'
    serviceClientState.current = createMockSupabase([
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        data: { id: jobId, status: 'pending', completed_count: 0, failed_count: 0 },
      },
      {
        table: 'prodai_generation_jobs',
        type: 'update-maybeSingle',
        data: null,
      },
      {
        table: 'prodai_generation_jobs',
        type: 'select-single',
        error: { message: 'read timeout' },
      },
    ])

    const { processGenerationJob } = await import('../generation-worker')

    await expect(processGenerationJob(jobId)).rejects.toThrow(
      'Failed to load latest generation job state: read timeout'
    )
  })
})
