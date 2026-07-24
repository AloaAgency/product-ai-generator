/**
 * Tests for /api/products/[id]/generate (src/app/api/products/[id]/generate/route.ts)
 *
 * The pure validation helpers already have direct unit tests in
 * src/lib/__tests__/generate-route-helpers.test.ts — these tests cover the
 * route's own orchestration, which is where a regression would corrupt jobs:
 *  - request validation rejects bad input before a database client exists
 *  - reference sets are verified to belong to the product and match their
 *    declared role before a job row is written
 *  - the compensating delete runs when attaching reference sets fails, so no
 *    orphaned "pending" job is ever left for the worker to pick up
 *  - the fix-image path rewrites the prompt and skips the reference-set
 *    requirement
 *  - DELETE maps each scope to the right status transitions (cancelling
 *    active jobs must never delete history; clearing the log must never
 *    touch running jobs)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { T } from '@/lib/db-tables'

const { createServiceClientMock, kickWorkerForJobMock, processGenerationJobMock } = vi.hoisted(() => ({
  createServiceClientMock: vi.fn(),
  kickWorkerForJobMock: vi.fn(),
  processGenerationJobMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: createServiceClientMock,
}))

vi.mock('@/lib/video-job-request', () => ({
  kickWorkerForJob: kickWorkerForJobMock,
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

import { GET, POST, DELETE } from './route'

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const SET_ID = '22222222-2222-4222-8222-222222222222'
const IMG_1 = '33333333-3333-4333-8333-333333333333'
const IMG_2 = '44444444-4444-4444-8444-444444444444'
const SOURCE_IMAGE_ID = '55555555-5555-4555-8555-555555555555'
const JOB_ID = '66666666-6666-4666-8666-666666666666'

type QueryResult = { data: unknown; error: unknown }

// ---------------------------------------------------------------------------
// POST — mock client with per-table dispatch matching the route's queries
// ---------------------------------------------------------------------------

function makePostClient(overrides: {
  product?: QueryResult
  refSets?: QueryResult
  refImages?: QueryResult
  sourceImage?: QueryResult
  jobInsert?: QueryResult
  joinInsertError?: unknown
} = {}) {
  const product = overrides.product ?? {
    data: { global_style_settings: {}, prodai_projects: null },
    error: null,
  }
  const refSets = overrides.refSets ?? { data: [{ id: SET_ID, type: 'product' }], error: null }
  const refImages = overrides.refImages ?? {
    data: [
      { id: IMG_1, reference_set_id: SET_ID },
      { id: IMG_2, reference_set_id: SET_ID },
    ],
    error: null,
  }
  const sourceImage = overrides.sourceImage ?? { data: null, error: null }
  const jobInsertResult = overrides.jobInsert ?? { data: { id: JOB_ID }, error: null }

  const jobInsert = vi.fn((_row: Record<string, unknown>) => ({
    select: vi.fn(() => ({ single: () => Promise.resolve(jobInsertResult) })),
  }))
  const jobDeleteEq = vi.fn(() => Promise.resolve({ error: null }))
  const joinInsert = vi.fn(() => Promise.resolve({ error: overrides.joinInsertError ?? null }))

  const from = vi.fn((table: string) => {
    switch (table) {
      case T.products:
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: () => Promise.resolve(product) })) })) }
      case T.reference_sets:
        return { select: vi.fn(() => ({ in: vi.fn(() => ({ eq: () => Promise.resolve(refSets) })) })) }
      case T.reference_images:
        return { select: vi.fn(() => ({ in: vi.fn(() => ({ order: () => Promise.resolve(refImages) })) })) }
      case T.generated_images:
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: () => Promise.resolve(sourceImage) })) })) }
      case T.generation_jobs:
        return { insert: jobInsert, delete: vi.fn(() => ({ eq: jobDeleteEq })) }
      case T.generation_job_reference_sets:
        return { insert: joinInsert }
      default:
        throw new Error(`Unexpected table: ${table}`)
    }
  })

  return { client: { from }, jobInsert, jobDeleteEq, joinInsert }
}

const postGenerate = (body: Record<string, unknown>, productId = PRODUCT_ID) =>
  POST(
    new NextRequest(`http://localhost/api/products/${productId}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: productId }) }
  )

const subjectSet = { reference_set_id: SET_ID, role: 'subject' }

beforeEach(() => {
  createServiceClientMock.mockReset()
  kickWorkerForJobMock.mockReset()
  processGenerationJobMock.mockReset()
  // Force the queued-worker path so tests never run inline generation.
  delete process.env.INLINE_GENERATION
})

describe('POST /api/products/[id]/generate — request validation', () => {
  it('rejects a missing prompt before creating a database client', async () => {
    const res = await postGenerate({ reference_sets: [subjectSet] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'prompt_text is required' })
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects an over-length prompt before creating a database client', async () => {
    const res = await postGenerate({
      prompt_text: 'x'.repeat(10001),
      reference_sets: [subjectSet],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/10000 characters or fewer/)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range variation_count before creating a database client', async () => {
    const res = await postGenerate({
      prompt_text: 'A hero shot',
      variation_count: 101,
      reference_sets: [subjectSet],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/between 1 and 100/)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('requires reference_sets for a normal (non fix-image) generation', async () => {
    const res = await postGenerate({ prompt_text: 'A hero shot' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/reference_sets must be a non-empty array/)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/products/[id]/generate — referential integrity', () => {
  it('returns 404 when the product does not exist', async () => {
    const { client } = makePostClient({ product: { data: null, error: { message: 'no rows' } } })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'A hero shot', reference_sets: [subjectSet] })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Product not found' })
  })

  it('rejects reference sets that do not belong to the product', async () => {
    // The reference-set query is scoped to product_id, so a set owned by a
    // different product comes back missing.
    const { client, jobInsert } = makePostClient({ refSets: { data: [], error: null } })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'A hero shot', reference_sets: [subjectSet] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/reference sets not found for this product/)
    expect(jobInsert).not.toHaveBeenCalled()
  })

  it('rejects a subject role pointing at a texture set', async () => {
    const { client, jobInsert } = makePostClient({
      refSets: { data: [{ id: SET_ID, type: 'texture' }], error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'A hero shot', reference_sets: [subjectSet] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/role "subject" doesn't match set type "texture"/)
    expect(jobInsert).not.toHaveBeenCalled()
  })

  it('rejects a source_image_id that does not exist', async () => {
    const { client, jobInsert } = makePostClient({
      sourceImage: { data: null, error: { message: 'no rows' } },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'Fix the label', source_image_id: SOURCE_IMAGE_ID })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Source image not found' })
    expect(jobInsert).not.toHaveBeenCalled()
  })
})

describe('POST /api/products/[id]/generate — job creation', () => {
  it('creates a pending image job and hands it to the worker', async () => {
    const { client, jobInsert, joinInsert } = makePostClient()
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({
      prompt_text: 'A hero shot',
      variation_count: 5,
      reference_sets: [subjectSet],
    })

    expect(res.status).toBe(201)
    expect((await res.json()).job).toEqual({ id: JOB_ID })

    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        product_id: PRODUCT_ID,
        variation_count: 5,
        status: 'pending',
        job_type: 'image',
        completed_count: 0,
        failed_count: 0,
        source_image_id: null,
      })
    )
    // Both images in the set are selected by default (count 2, no explicit ids).
    expect(joinInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        job_id: JOB_ID,
        reference_set_id: SET_ID,
        role: 'subject',
        display_order: 0,
        image_count: 2,
        selected_image_ids: null,
      }),
    ])
    expect(kickWorkerForJobMock).toHaveBeenCalledWith(
      JOB_ID,
      expect.stringContaining('/generate'),
      '[Generate]',
      expect.any(Object)
    )
    expect(processGenerationJobMock).not.toHaveBeenCalled()
  })

  it('fix-image jobs skip reference sets and rewrite the prompt around the source image', async () => {
    const { client, jobInsert, joinInsert } = makePostClient({
      sourceImage: { data: { id: SOURCE_IMAGE_ID }, error: null },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({
      prompt_text: 'Remove the smudge on the label',
      source_image_id: SOURCE_IMAGE_ID,
    })

    expect(res.status).toBe(201)
    const insertedJob = jobInsert.mock.calls[0][0]
    expect(insertedJob.source_image_id).toBe(SOURCE_IMAGE_ID)
    expect(insertedJob.final_prompt).toContain(
      'recreate it with the following modifications: Remove the smudge on the label'
    )
    expect(joinInsert).not.toHaveBeenCalled()
  })

  it('returns 500 when the job row cannot be created', async () => {
    const { client, joinInsert } = makePostClient({
      jobInsert: { data: null, error: { message: 'insert failed' } },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'A hero shot', reference_sets: [subjectSet] })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create generation job' })
    expect(joinInsert).not.toHaveBeenCalled()
    expect(kickWorkerForJobMock).not.toHaveBeenCalled()
  })

  it('rolls the job back when attaching reference sets fails', async () => {
    const { client, jobDeleteEq } = makePostClient({
      joinInsertError: { message: 'join insert failed' },
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await postGenerate({ prompt_text: 'A hero shot', reference_sets: [subjectSet] })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to attach reference sets to job' })
    // The compensating delete must remove the just-created job so the worker
    // never picks up a pending job with missing reference sets.
    expect(jobDeleteEq).toHaveBeenCalledWith('id', JOB_ID)
    expect(kickWorkerForJobMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET — jobs listing
// ---------------------------------------------------------------------------

function makeJobsListClient(result: QueryResult) {
  const callLog: Array<[string, unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'range']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      callLog.push([m, args])
      return chain
    })
  }
  chain.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected)
  const from = vi.fn(() => chain)
  return { client: { from }, callLog }
}

describe('GET /api/products/[id]/generate', () => {
  it('applies default pagination and an optional status filter', async () => {
    const jobs = [{ id: JOB_ID, status: 'failed' }]
    const { client, callLog } = makeJobsListClient({ data: jobs, error: null })
    createServiceClientMock.mockReturnValue(client)

    const res = await GET(
      new NextRequest(`http://localhost/api/products/${PRODUCT_ID}/generate?status=failed`),
      { params: Promise.resolve({ id: PRODUCT_ID }) }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(jobs)
    expect(callLog).toContainEqual(['range', [0, 49]])
    expect(callLog).toContainEqual(['eq', ['product_id', PRODUCT_ID]])
    expect(callLog).toContainEqual(['eq', ['status', 'failed']])
  })

  it('returns 500 with a generic message when the query fails', async () => {
    const { client } = makeJobsListClient({ data: null, error: { message: 'db down' } })
    createServiceClientMock.mockReturnValue(client)

    const res = await GET(
      new NextRequest(`http://localhost/api/products/${PRODUCT_ID}/generate`),
      { params: Promise.resolve({ id: PRODUCT_ID }) }
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch jobs' })
  })
})

// ---------------------------------------------------------------------------
// DELETE — scope handling
// ---------------------------------------------------------------------------

type MutationRecord = { op: string; filters: Array<[string, unknown[]]> }

function makeJobsMutationClient(options: {
  cancelRows?: unknown[]
  failedRows?: unknown[]
  logRows?: unknown[]
  updateError?: unknown
} = {}) {
  const records: MutationRecord[] = []
  const from = vi.fn(() => {
    const record: MutationRecord = { op: '', filters: [] }
    records.push(record)
    const chain: Record<string, unknown> = {}
    for (const m of ['update', 'delete', 'select', 'eq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        if (m === 'update' || m === 'delete') record.op = m
        record.filters.push([m, args])
        return chain
      })
    }
    chain.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
      let result: QueryResult
      if (record.op === 'update') {
        result = { data: options.cancelRows ?? [], error: options.updateError ?? null }
      } else if (record.filters.some(([m, args]) => m === 'eq' && args[0] === 'status')) {
        result = { data: options.failedRows ?? [], error: null }
      } else {
        result = { data: options.logRows ?? [], error: null }
      }
      return Promise.resolve(result).then(onFulfilled, onRejected)
    }
    return chain
  })
  return { client: { from }, records }
}

const deleteJobs = (scope?: string) =>
  DELETE(
    new NextRequest(
      `http://localhost/api/products/${PRODUCT_ID}/generate${scope ? `?scope=${scope}` : ''}`,
      { method: 'DELETE' }
    ),
    { params: Promise.resolve({ id: PRODUCT_ID }) }
  )

describe('DELETE /api/products/[id]/generate — scopes', () => {
  it('rejects an unknown scope before creating a database client', async () => {
    const res = await deleteJobs('everything')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid scope/)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('defaults to the active scope: cancels pending/running jobs, deletes nothing', async () => {
    const { client, records } = makeJobsMutationClient({ cancelRows: [{ id: '1' }, { id: '2' }] })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteJobs()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cancelled: 2, cleared_failed: 0, cleared_log: 0 })
    expect(records).toHaveLength(1)
    expect(records[0].op).toBe('update')
    expect(records[0].filters).toContainEqual(['in', ['status', ['pending', 'running']]])
    expect(records[0].filters).toContainEqual(['eq', ['product_id', PRODUCT_ID]])
    const updatePayload = records[0].filters.find(([m]) => m === 'update')?.[1][0]
    expect(updatePayload).toMatchObject({ status: 'cancelled', error_message: 'Cancelled by user' })
  })

  it('scope=failed only deletes failed jobs', async () => {
    const { client, records } = makeJobsMutationClient({ failedRows: [{ id: '1' }] })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteJobs('failed')

    expect(await res.json()).toEqual({ cancelled: 0, cleared_failed: 1, cleared_log: 0 })
    expect(records).toHaveLength(1)
    expect(records[0].op).toBe('delete')
    expect(records[0].filters).toContainEqual(['eq', ['status', 'failed']])
  })

  it('scope=all cancels active jobs and clears failed ones', async () => {
    const { client, records } = makeJobsMutationClient({
      cancelRows: [{ id: '1' }],
      failedRows: [{ id: '2' }, { id: '3' }],
    })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteJobs('all')

    expect(await res.json()).toEqual({ cancelled: 1, cleared_failed: 2, cleared_log: 0 })
    expect(records.map(r => r.op)).toEqual(['update', 'delete'])
  })

  it('scope=log clears only finished jobs and never touches running ones', async () => {
    const { client, records } = makeJobsMutationClient({ logRows: [{ id: '1' }, { id: '2' }] })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteJobs('log')

    expect(await res.json()).toEqual({ cancelled: 0, cleared_failed: 0, cleared_log: 2 })
    expect(records).toHaveLength(1)
    expect(records[0].op).toBe('delete')
    expect(records[0].filters).toContainEqual(['in', ['status', ['completed', 'failed', 'cancelled']]])
  })

  it('returns 500 when cancelling active jobs fails', async () => {
    const { client } = makeJobsMutationClient({ updateError: { message: 'db down' } })
    createServiceClientMock.mockReturnValue(client)

    const res = await deleteJobs('active')
    expect(res.status).toBe(500)
  })
})
