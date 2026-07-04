/**
 * Tests for the auth guard in src/app/api/worker/generate/route.ts
 *
 * The worker is the primary externally-reachable endpoint that bypasses
 * site-password middleware and relies solely on CRON_SECRET.  These tests
 * verify fail-closed behaviour and that both accepted auth schemes
 * (x-cron-secret header and Authorization: Bearer token) work correctly.
 *
 * Only 401-path tests are guaranteed to be free of Supabase calls.
 * Authorized-path tests additionally confirm auth passed (status !== 401)
 * using a minimal Supabase mock that returns empty job queues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Data returned by every query in the mock Supabase chain. Defaults to an
// empty queue; batch-processing tests set this to a list of pending jobs
// before calling GET and reset it in afterEach.
let queryData: unknown[] = []

// When true, the mocked createServiceClient throws like the real one does
// when the Supabase env vars are missing.
let serviceClientShouldThrow = false

// Build a chainable mock that bottoms out in a resolved Promise returning
// `queryData`.  The worker queries stale jobs then pending jobs; both are
// satisfied by the same fluent chain returning { data: queryData, error: null }.
function makeQueryChain(): Record<string, unknown> {
  const leaf = () => Promise.resolve({ data: queryData, error: null, count: 0 })
  const chain: Record<string, unknown> = {}
  const methods = ['update', 'select', 'eq', 'lt', 'order', 'limit', 'not', 'is']
  for (const m of methods) {
    chain[m] = () => Object.assign(leaf, chain)
  }
  // Allow `await supabase.from(...).select(...).eq(...).order(...).limit(...)`
  // by making the chain itself thenable (Promise-like).
  Object.assign(chain, { then: leaf().then.bind(leaf()) })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (serviceClientShouldThrow) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    }
    return {
      from: () => makeQueryChain(),
    }
  },
}))

vi.mock('@/lib/generation-worker', () => ({
  processGenerationJob: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/lib/error-logger', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}))

async function importGET() {
  const mod = await import('@/app/api/worker/generate/route')
  return mod.GET
}

function buildRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/worker/generate', {
    method: 'GET',
    headers,
  })
}

// ---------------------------------------------------------------------------
// Fail-closed — CRON_SECRET not configured
// ---------------------------------------------------------------------------

describe('GET /api/worker/generate — CRON_SECRET not configured', () => {
  let GET: Awaited<ReturnType<typeof importGET>>

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.CRON_SECRET
    GET = await importGET()
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('returns 401 when CRON_SECRET env var is missing', async () => {
    const req = buildRequest({ 'x-cron-secret': 'anything' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 even with a Bearer token when CRON_SECRET is not set', async () => {
    const req = buildRequest({ Authorization: 'Bearer anything' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 with no auth headers when CRON_SECRET is not set', async () => {
    const req = buildRequest()
    const res = await GET(req)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Unauthorized — wrong or missing credentials
// ---------------------------------------------------------------------------

describe('GET /api/worker/generate — unauthorized requests', () => {
  let GET: Awaited<ReturnType<typeof importGET>>

  beforeEach(async () => {
    vi.resetModules()
    process.env.CRON_SECRET = 'correct-secret'
    GET = await importGET()
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('returns 401 when no auth headers are present', async () => {
    const req = buildRequest()
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when x-cron-secret header has the wrong value', async () => {
    const req = buildRequest({ 'x-cron-secret': 'wrong-secret' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when Authorization Bearer token has the wrong value', async () => {
    const req = buildRequest({ Authorization: 'Bearer wrong-secret' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 for an empty x-cron-secret header', async () => {
    const req = buildRequest({ 'x-cron-secret': '' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
    // The secret without the "Bearer " prefix must not authenticate.
    const req = buildRequest({ Authorization: 'correct-secret' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns a generic error body without leaking which check failed', async () => {
    const req = buildRequest({ 'x-cron-secret': 'wrong' })
    const res = await GET(req)
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })
})

// ---------------------------------------------------------------------------
// Authorized — correct credentials pass the auth gate
// ---------------------------------------------------------------------------

describe('GET /api/worker/generate — authorized requests pass auth gate', () => {
  let GET: Awaited<ReturnType<typeof importGET>>

  beforeEach(async () => {
    vi.resetModules()
    process.env.CRON_SECRET = 'correct-secret'
    GET = await importGET()
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('passes auth with correct x-cron-secret header (status is not 401)', async () => {
    const req = buildRequest({ 'x-cron-secret': 'correct-secret' })
    const res = await GET(req)
    expect(res.status).not.toBe(401)
  })

  it('passes auth with correct Authorization: Bearer token (status is not 401)', async () => {
    const req = buildRequest({ Authorization: 'Bearer correct-secret' })
    const res = await GET(req)
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Per-job failure isolation — one bad job must not abort the batch
// ---------------------------------------------------------------------------

describe('GET /api/worker/generate — per-job failure isolation', () => {
  let GET: Awaited<ReturnType<typeof importGET>>

  beforeEach(async () => {
    vi.resetModules()
    process.env.CRON_SECRET = 'correct-secret'
    GET = await importGET()
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    queryData = []
  })

  it('keeps processing remaining jobs and returns 200 when one job throws', async () => {
    queryData = [
      { id: 'job-1', status: 'pending', created_at: '2026-01-01T00:00:00Z', job_type: 'image' },
      { id: 'job-2', status: 'pending', created_at: '2026-01-01T00:00:01Z', job_type: 'image' },
    ]
    // Import from the same (reset) module registry the route handler uses so
    // we configure the exact mock instance the route calls.
    const { processGenerationJob } = await import('@/lib/generation-worker')
    vi.mocked(processGenerationJob)
      .mockRejectedValueOnce(new Error('transient claim failure'))
      .mockResolvedValueOnce({ jobId: 'job-2', processed: 1, completed: 1, failed: 0, status: 'completed' })

    const res = await GET(buildRequest({ 'x-cron-secret': 'correct-secret' }))
    expect(res.status).toBe(200)

    const body = await res.json()
    // Both jobs were attempted: the second job's success was not discarded
    // because of the first job's error.
    expect(processGenerationJob).toHaveBeenCalledTimes(2)
    expect(body.processed).toBe(2)
    const byJob = Object.fromEntries(
      (body.results as Array<{ jobId: string; status: string }>).map((r) => [r.jobId, r.status])
    )
    expect(byJob['job-1']).toBe('error')
    expect(byJob['job-2']).toBe('completed')
  })

  it('still returns 200 with an error result when every job in the batch throws', async () => {
    queryData = [
      { id: 'job-1', status: 'pending', created_at: '2026-01-01T00:00:00Z', job_type: 'image' },
    ]
    const { processGenerationJob } = await import('@/lib/generation-worker')
    vi.mocked(processGenerationJob).mockRejectedValueOnce(new Error('boom'))

    const res = await GET(buildRequest({ 'x-cron-secret': 'correct-secret' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.processed).toBe(1)
    expect(body.results[0]).toMatchObject({ jobId: 'job-1', status: 'error' })
  })
})

// ---------------------------------------------------------------------------
// Service-client construction failure — structured 500 instead of an
// unhandled throw when the Supabase env vars are missing
// ---------------------------------------------------------------------------

describe('GET /api/worker/generate — service client construction fails', () => {
  let GET: Awaited<ReturnType<typeof importGET>>

  beforeEach(async () => {
    vi.resetModules()
    process.env.CRON_SECRET = 'correct-secret'
    serviceClientShouldThrow = true
    GET = await importGET()
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    serviceClientShouldThrow = false
  })

  it('returns a structured 500 JSON error instead of throwing', async () => {
    const req = buildRequest({ 'x-cron-secret': 'correct-secret' })
    // Before createServiceClient() moved inside the try block, this call
    // rejected — an unhandled exception surfacing as an opaque 500.
    const res = await GET(req)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('still rejects unauthorized requests with 401 before touching Supabase', async () => {
    const req = buildRequest({ 'x-cron-secret': 'wrong-secret' })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })
})
