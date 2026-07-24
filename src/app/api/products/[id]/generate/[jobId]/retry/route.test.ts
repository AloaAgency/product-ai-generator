/**
 * Tests for POST /api/products/[id]/generate/[jobId]/retry
 * (src/app/api/products/[id]/generate/[jobId]/retry/route.ts)
 *
 * Retry re-queues a finished job, so the gating logic is what protects
 * running work: the job must be fetched scoped to the product, only jobs
 * that actually failed may be reset, and the reset UPDATE itself is guarded
 * by an `.in('status', ['failed', 'completed'])` filter so a concurrent
 * retry (or a job that started running in between) cannot be clobbered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { createServiceClientMock, kickWorkerForJobMock, shouldRunInlineMock, processGenerationJobMock } =
  vi.hoisted(() => ({
    createServiceClientMock: vi.fn(),
    kickWorkerForJobMock: vi.fn(),
    shouldRunInlineMock: vi.fn(() => false),
    processGenerationJobMock: vi.fn(),
  }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: createServiceClientMock,
}))

vi.mock('@/lib/video-job-request', () => ({
  kickWorkerForJob: kickWorkerForJobMock,
  shouldRunVideoGenerationInline: shouldRunInlineMock,
}))

vi.mock('@/lib/generation-worker', () => ({
  processGenerationJob: processGenerationJobMock,
}))

vi.mock('@/lib/error-logger', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/server-logger', () => {
  const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  return { logger: noopLogger, createLogger: () => noopLogger }
})

import { POST } from './route'

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '22222222-2222-4222-8222-222222222222'

type QueryResult = { data: unknown; error: unknown }

function makeClient(options: {
  job?: Record<string, unknown> | null
  fetchError?: unknown
  updateResult?: QueryResult
}) {
  const selectFilters: Array<[string, unknown]> = []
  const selectEq = vi.fn(function chainEq(col: string, val: unknown) {
    selectFilters.push([col, val])
    return {
      eq: selectEq,
      single: () =>
        Promise.resolve({ data: options.job ?? null, error: options.fetchError ?? null }),
    }
  })

  const updateIn = vi.fn(() => ({
    select: vi.fn(() => ({
      single: () =>
        Promise.resolve(options.updateResult ?? { data: null, error: { message: 'no rows' } }),
    })),
  }))
  const updateEq = vi.fn(() => ({ in: updateIn }))
  const update = vi.fn(() => ({ eq: updateEq }))

  const from = vi.fn(() => ({
    select: vi.fn(() => ({ eq: selectEq })),
    update,
  }))

  return { client: { from }, selectFilters, update, updateEq, updateIn }
}

const retryJob = () =>
  POST(
    new NextRequest(`http://localhost/api/products/${PRODUCT_ID}/generate/${JOB_ID}/retry`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: PRODUCT_ID, jobId: JOB_ID }) }
  )

beforeEach(() => {
  createServiceClientMock.mockReset()
  kickWorkerForJobMock.mockReset()
  processGenerationJobMock.mockReset()
  shouldRunInlineMock.mockReturnValue(false)
})

describe('POST retry — job lookup', () => {
  it('scopes the job fetch to both job id and product id', async () => {
    const { client, selectFilters } = makeClient({ job: null, fetchError: { message: 'no rows' } })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Job not found' })
    // A job id belonging to another product must 404, not retry.
    expect(selectFilters).toContainEqual(['id', JOB_ID])
    expect(selectFilters).toContainEqual(['product_id', PRODUCT_ID])
  })
})

describe('POST retry — gating', () => {
  it('rejects retrying a job that partially succeeded', async () => {
    const { client, update } = makeClient({
      job: { id: JOB_ID, status: 'completed', completed_count: 3, failed_count: 2 },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Only failed jobs can be retried' })
    expect(update).not.toHaveBeenCalled()
    expect(kickWorkerForJobMock).not.toHaveBeenCalled()
  })

  it('rejects retrying a running job', async () => {
    const { client, update } = makeClient({
      job: { id: JOB_ID, status: 'running', completed_count: 0, failed_count: 0 },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('allows retrying a failed job', async () => {
    const updated = { id: JOB_ID, status: 'pending' }
    const { client } = makeClient({
      job: { id: JOB_ID, status: 'failed', completed_count: 0, failed_count: 5 },
      updateResult: { data: updated, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ job: updated })
  })

  it('allows retrying a completed job whose variations all failed', async () => {
    const updated = { id: JOB_ID, status: 'pending' }
    const { client } = makeClient({
      job: { id: JOB_ID, status: 'completed', completed_count: 0, failed_count: 15 },
      updateResult: { data: updated, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(200)
  })
})

describe('POST retry — reset semantics', () => {
  it('resets counters and timestamps, guarded against concurrent state changes', async () => {
    const updated = { id: JOB_ID, status: 'pending' }
    const { client, update, updateEq, updateIn } = makeClient({
      job: { id: JOB_ID, status: 'failed', completed_count: 0, failed_count: 5 },
      updateResult: { data: updated, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    await retryJob()

    expect(update).toHaveBeenCalledWith({
      status: 'pending',
      completed_count: 0,
      failed_count: 0,
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    expect(updateEq).toHaveBeenCalledWith('id', JOB_ID)
    // The status guard is the race protection: if the job moved to
    // pending/running between the fetch and the update, no row matches.
    expect(updateIn).toHaveBeenCalledWith('status', ['failed', 'completed'])
  })

  it('returns 500 when the guarded update matches no row (lost race)', async () => {
    const { client } = makeClient({
      job: { id: JOB_ID, status: 'failed', completed_count: 0, failed_count: 1 },
      updateResult: { data: null, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to retry job' })
    expect(kickWorkerForJobMock).not.toHaveBeenCalled()
  })

  it('kicks the background worker after a successful reset', async () => {
    const { client } = makeClient({
      job: { id: JOB_ID, status: 'failed', completed_count: 0, failed_count: 1 },
      updateResult: { data: { id: JOB_ID, status: 'pending' }, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    await retryJob()

    expect(kickWorkerForJobMock).toHaveBeenCalledWith(
      JOB_ID,
      expect.stringContaining('/retry'),
      '[RetryGeneration]'
    )
    expect(processGenerationJobMock).not.toHaveBeenCalled()
  })

  it('runs the job inline instead of kicking the worker when configured', async () => {
    shouldRunInlineMock.mockReturnValue(true)
    processGenerationJobMock.mockResolvedValue({ status: 'completed' })
    const { client } = makeClient({
      job: { id: JOB_ID, status: 'failed', completed_count: 0, failed_count: 1 },
      updateResult: { data: { id: JOB_ID, status: 'pending' }, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await retryJob()

    expect(res.status).toBe(200)
    expect(processGenerationJobMock).toHaveBeenCalledWith(JOB_ID)
    expect(kickWorkerForJobMock).not.toHaveBeenCalled()
  })
})
