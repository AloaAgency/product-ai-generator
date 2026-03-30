import { beforeEach, describe, expect, it, vi } from 'vitest'

type QueryResponse = {
  table: string
  type: 'select-single' | 'select-maybeSingle' | 'update-maybeSingle' | 'select-order' | 'insert'
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

function createMockSupabase(queryResponses: QueryResponse[]) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const queryQueue = [...queryResponses]

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

  const supabase = {
    updates,
    storage: {
      from() {
        return {
          upload: vi.fn(),
          download: vi.fn(),
        }
      },
    },
    from(table: string) {
      const state: { mode: 'select' | 'update' | 'insert' | null } = { mode: null }
      const builder = {
        select() {
          if (state.mode !== 'update') {
            state.mode = 'select'
          }
          return builder
        },
        update(values: Record<string, unknown>) {
          state.mode = 'update'
          updates.push({ table, values })
          return builder
        },
        insert() {
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
})
