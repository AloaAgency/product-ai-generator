import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './store'

const productA = '11111111-1111-4111-8111-111111111111'
const productB = '22222222-2222-4222-8222-222222222222'
const referenceSetA = '33333333-3333-4333-8333-333333333333'
const settingsTemplateA = '44444444-4444-4444-8444-444444444444'
const referenceImageA = '55555555-5555-4555-8555-555555555555'
const generationJobA = '66666666-6666-4666-8666-666666666666'
const generatedImageA = '77777777-7777-4777-8777-777777777777'

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
      projects: [],
      products: [],
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
      settingsTemplates: [],
      loadingSettingsTemplates: false,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('preserves a previously loaded project list when a refresh returns malformed JSON', async () => {
    const project = {
      id: productA,
      user_id: 'user-a',
      name: 'Project A',
      description: null,
      global_style_settings: {},
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    }
    let calls = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/projects') {
        calls += 1
        return Promise.resolve(calls === 1 ? jsonResponse([project]) : jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProjects()
    expect(useAppStore.getState().projects).toEqual([project])

    await useAppStore.getState().fetchProjects()
    expect(useAppStore.getState().projects).toEqual([project])
  })

  it('preserves loaded gallery images when a gallery refresh returns malformed JSON', async () => {
    const image = {
      id: generatedImageA,
      job_id: generationJobA,
      variation_number: 1,
      storage_path: 'images/a.png',
      public_url: null,
      thumb_storage_path: null,
      thumb_public_url: null,
      preview_storage_path: null,
      preview_public_url: null,
      mime_type: 'image/png',
      file_size: 1,
      approval_status: 'pending',
      notes: null,
      media_type: 'image',
      scene_id: null,
      scene_name: null,
      created_at: '2026-07-06T00:00:00.000Z',
    }
    let galleryCalls = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url.startsWith(`/api/products/${productA}/gallery?`)) {
        galleryCalls += 1
        return Promise.resolve(
          galleryCalls === 1
            ? jsonResponse({ images: [image], total: 1, has_more: false })
            : jsonResponse({ ok: true })
        )
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGallery(productA)
    expect(useAppStore.getState().galleryImages).toEqual([image])

    await useAppStore.getState().fetchGallery(productA)
    expect(useAppStore.getState().galleryImages).toEqual([image])
    expect(useAppStore.getState().galleryTotal).toBe(1)
    expect(useAppStore.getState().galleryHasMore).toBe(false)
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

  it('does not append a settings template when its create request completes after product navigation', async () => {
    const pendingCreate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/settings-templates` && init?.method !== 'POST') {
        return Promise.resolve(jsonResponse([]))
      }
      if (url === `/api/products/${productA}/settings-templates` && init?.method === 'POST') {
        return pendingCreate.promise
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchSettingsTemplates(productA)
    const createPromise = useAppStore
      .getState()
      .createSettingsTemplate(productA, { name: 'Template A', settings: {} })
    await useAppStore.getState().fetchProduct(productB)

    pendingCreate.resolve(
      jsonResponse({
        id: settingsTemplateA,
        product_id: productA,
        name: 'Template A',
        settings: {},
        is_active: false,
      }, 201)
    )
    const created = await createPromise

    expect(created.id).toBe(settingsTemplateA)
    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().settingsTemplates).toEqual([])
  })

  it('does not append reference images when upload finalization completes after product navigation', async () => {
    const pendingFinalize = deferred<Response>()
    const finalizeStarted = deferred<void>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/reference-sets`) {
        return Promise.resolve(jsonResponse([]))
      }
      if (
        url === `/api/products/${productA}/reference-sets/${referenceSetA}/images/upload-urls` &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { files?: Array<{ clientId: string }> }
        const clientId = body.files?.[0]?.clientId ?? 'missing-client'
        return Promise.resolve(jsonResponse([{
          clientId,
          signedUrl: '/signed-upload',
          storage_path: 'references/photo.png',
          file_name: 'photo.png',
          mime_type: 'image/png',
          file_size: 1,
          display_order: 1,
        }]))
      }
      if (url === '/signed-upload' && method === 'PUT') {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (url === `/api/products/${productA}/reference-sets/${referenceSetA}/images` && method === 'POST') {
        finalizeStarted.resolve()
        return pendingFinalize.promise
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchReferenceSets(productA)
    const uploadPromise = useAppStore
      .getState()
      .uploadReferenceImages(productA, referenceSetA, [
        new File(['x'], 'photo.png', { type: 'image/png' }),
      ])
    await finalizeStarted.promise
    await useAppStore.getState().fetchProduct(productB)

    pendingFinalize.resolve(jsonResponse([{
      id: referenceImageA,
      reference_set_id: referenceSetA,
      storage_path: 'references/photo.png',
      public_url: null,
      file_name: 'photo.png',
      mime_type: 'image/png',
      file_size: 1,
      display_order: 1,
      created_at: '2026-07-06T00:00:00.000Z',
    }], 201))
    await uploadPromise

    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().referenceImages).toEqual({})
  })

  it('rejects malformed upload signing responses with a stable error', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url === `/api/products/${productA}/reference-sets/${referenceSetA}/images/upload-urls` &&
        init?.method === 'POST'
      ) {
        return Promise.resolve(jsonResponse({ error: 'not an array' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore
        .getState()
        .uploadReferenceImages(productA, referenceSetA, [
          new File(['x'], 'photo.png', { type: 'image/png' }),
        ])
    ).rejects.toThrow('Failed to sign upload')
    expect(useAppStore.getState().referenceImages).toEqual({})
  })

  it('rejects malformed upload finalization responses with a stable error', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (
        url === `/api/products/${productA}/reference-sets/${referenceSetA}/images/upload-urls` &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { files?: Array<{ clientId: string }> }
        const clientId = body.files?.[0]?.clientId ?? 'missing-client'
        return Promise.resolve(jsonResponse([{
          clientId,
          signedUrl: '/signed-upload',
          storage_path: 'references/photo.png',
          file_name: 'photo.png',
          mime_type: 'image/png',
          file_size: 1,
          display_order: 1,
        }]))
      }
      if (url === '/signed-upload' && method === 'PUT') {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (url === `/api/products/${productA}/reference-sets/${referenceSetA}/images` && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore
        .getState()
        .uploadReferenceImages(productA, referenceSetA, [
          new File(['x'], 'photo.png', { type: 'image/png' }),
        ])
    ).rejects.toThrow('Upload finalization failed')
    expect(useAppStore.getState().referenceImages).toEqual({})
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
