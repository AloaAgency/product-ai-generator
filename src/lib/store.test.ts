import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './store'

const productA = '11111111-1111-4111-8111-111111111111'
const productB = '22222222-2222-4222-8222-222222222222'
const referenceSetA = '33333333-3333-4333-8333-333333333333'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAppStore async scope guards', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentProduct: null,
      referenceSets: [],
      referenceImages: {},
      promptTemplates: [],
      generationJobs: [],
      currentJob: null,
      galleryImages: [],
      galleryTotal: 0,
      galleryHasMore: false,
      loadingRefSets: false,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores a reference-set fetch that resolves after the current product changes', async () => {
    const pendingReferenceSets = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}/reference-sets`) {
        return pendingReferenceSets.promise
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    const referenceSetsPromise = useAppStore.getState().fetchReferenceSets(productA)
    await useAppStore.getState().fetchProduct(productB)

    pendingReferenceSets.resolve(jsonResponse([{ id: referenceSetA, product_id: productA, name: 'A set' }]))
    await referenceSetsPromise

    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().referenceSets).toEqual([])
    expect(useAppStore.getState().loadingRefSets).toBe(false)
  })

  it('does not append a reference set when its create request completes after product navigation', async () => {
    const pendingCreate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/products/${productA}/reference-sets` && init?.method === 'POST') {
        return pendingCreate.promise
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    const createPromise = useAppStore
      .getState()
      .createReferenceSet(productA, { name: 'A set', description: 'stale' })
    await useAppStore.getState().fetchProduct(productB)

    pendingCreate.resolve(jsonResponse({ id: referenceSetA, product_id: productA, name: 'A set' }, 201))
    const created = await createPromise

    expect(created.id).toBe(referenceSetA)
    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().referenceSets).toEqual([])
  })
})

describe('useAppStore storage resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useAppStore.setState({ devParallelGeneration: true })
  })

  it('keeps dev parallel state in memory when localStorage writes fail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('storage unavailable')
        }),
      },
    })

    expect(() => useAppStore.getState().setDevParallelGeneration(false)).not.toThrow()
    expect(useAppStore.getState().devParallelGeneration).toBe(false)
  })
})
