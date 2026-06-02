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

// Build a chainable mock that bottoms out in a resolved Promise returning
// empty data.  The worker queries stale jobs then pending jobs; both are
// satisfied by the same fluent chain returning { data: [], error: null }.
function makeQueryChain(): Record<string, unknown> {
  const leaf = () => Promise.resolve({ data: [], error: null, count: 0 })
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
  createServiceClient: () => ({
    from: () => makeQueryChain(),
  }),
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
