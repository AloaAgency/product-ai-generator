import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './store'
import type { GeneratedImage, GenerationJob } from './types'

const productA = '11111111-1111-4111-8111-111111111111'
const productB = '22222222-2222-4222-8222-222222222222'
const referenceSetA = '33333333-3333-4333-8333-333333333333'
const settingsTemplateA = '44444444-4444-4444-8444-444444444444'
const referenceImageA = '55555555-5555-4555-8555-555555555555'
const generationJobA = '66666666-6666-4666-8666-666666666666'
const generationJobB = '66666666-6666-4666-8666-777777777777'
const generatedImageA = '77777777-7777-4777-8777-777777777777'
const generatedImageB = '88888888-8888-4888-8888-888888888888'

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

const makeGeneratedImage = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
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
  ...overrides,
})

const makeGenerationJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: generationJobA,
  product_id: productA,
  prompt_template_id: null,
  final_prompt: 'Make a product image',
  variation_count: 1,
  resolution: '2K',
  aspect_ratio: '1:1',
  status: 'completed',
  completed_count: 1,
  failed_count: 0,
  error_message: null,
  generation_model: 'gemini',
  job_type: 'image',
  scene_id: null,
  source_image_id: null,
  created_at: '2026-07-06T00:00:00.000Z',
  started_at: null,
  completed_at: '2026-07-06T00:01:00.000Z',
  ...overrides,
})

describe('useAppStore async scope guards', () => {
  beforeEach(() => {
    useAppStore.setState({
      projects: [],
      currentProject: null,
      products: [],
      currentProduct: null,
      referenceSets: [],
      referenceImages: {},
      promptTemplates: [],
      generationJobs: [],
      generationJobsHasMore: false,
      currentJob: null,
      galleryImages: [],
      galleryTotal: 0,
      galleryHasMore: false,
      loadingRefSets: false,
      loadingJobsMore: false,
      loadingGallery: false,
      loadingGalleryMore: false,
      settingsTemplates: [],
      loadingSettingsTemplates: false,
      errorLogs: [],
      loadingErrorLogs: false,
      aiLoading: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('retries retryable project fetch responses before updating state', async () => {
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/projects') {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'busy' }), {
              status: 503,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '0',
              },
            })
          )
        }
        return Promise.resolve(jsonResponse([project]))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    await useAppStore.getState().fetchProjects()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().projects).toEqual([project])
  })

  it('confines authenticated app API credentials to the same origin', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([])))
    vi.stubGlobal('fetch', fetchMock)

    await useAppStore.getState().fetchProjects()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({ credentials: 'same-origin' })
    )
  })

  it('keeps authenticated app API responses out of the browser cache', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([])))
    vi.stubGlobal('fetch', fetchMock)

    await useAppStore.getState().fetchProjects()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('preserves loaded gallery images when a gallery refresh returns malformed JSON', async () => {
    const image: GeneratedImage = {
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

  it('preserves gallery identities when polling returns unchanged images', async () => {
    const image = makeGeneratedImage({
      public_url: 'https://example.test/image',
      thumb_public_url: 'https://example.test/thumb',
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url.startsWith(`/api/products/${productA}/gallery?`)) {
        return Promise.resolve(jsonResponse({ images: [image], total: 1, has_more: false }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGallery(productA)
    const firstImages = useAppStore.getState().galleryImages
    const firstImage = firstImages[0]

    await useAppStore.getState().fetchGallery(productA)

    expect(useAppStore.getState().galleryImages).toBe(firstImages)
    expect(useAppStore.getState().galleryImages[0]).toBe(firstImage)
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

  it('aborts a product-scoped fetch when navigation makes it stale', async () => {
    let referenceFetchAborted = false
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/reference-sets`) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            referenceFetchAborted = true
            reject(init.signal?.reason)
          }, { once: true })
        })
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    const referenceSetsPromise = useAppStore.getState().fetchReferenceSets(productA)
    await useAppStore.getState().fetchProduct(productB)
    await referenceSetsPromise

    expect(referenceFetchAborted).toBe(true)
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

  it('applies activated template settings without re-fetching the product', async () => {
    const settings = { lighting: 'Soft daylight', default_resolution: '4K' as const }
    const template = {
      id: settingsTemplateA,
      product_id: productA,
      name: 'Template A',
      settings,
      is_active: false,
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    }
    let productGets = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}` && method === 'GET') {
        productGets += 1
        return Promise.resolve(jsonResponse({
          id: productA,
          name: 'Product A',
          global_style_settings: {},
        }))
      }
      if (url === `/api/products/${productA}/settings-templates` && method === 'GET') {
        return Promise.resolve(jsonResponse([template]))
      }
      if (
        url === `/api/products/${productA}/settings-templates/${settingsTemplateA}` &&
        method === 'PATCH'
      ) {
        return Promise.resolve(jsonResponse({ ...template, is_active: true }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchSettingsTemplates(productA)
    await useAppStore.getState().activateSettingsTemplate(productA, settingsTemplateA)

    expect(productGets).toBe(1)
    expect(useAppStore.getState().currentProduct?.global_style_settings).toEqual(settings)
    expect(useAppStore.getState().settingsTemplates).toEqual([
      expect.objectContaining({ id: settingsTemplateA, is_active: true }),
    ])
  })

  it('re-fetches the product after activation when no product record can be updated locally', async () => {
    const settings = { lighting: 'Soft daylight' }
    const template = {
      id: settingsTemplateA,
      product_id: productA,
      name: 'Template A',
      settings,
      is_active: false,
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    }
    let productGets = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}` && method === 'GET') {
        productGets += 1
        return Promise.resolve(jsonResponse({
          id: productA,
          name: 'Product A',
          global_style_settings: productGets === 1 ? {} : settings,
        }))
      }
      if (url === `/api/products/${productA}/settings-templates` && method === 'GET') {
        return Promise.resolve(jsonResponse([template]))
      }
      if (
        url === `/api/products/${productA}/settings-templates/${settingsTemplateA}` &&
        method === 'PATCH'
      ) {
        return Promise.resolve(jsonResponse({ ...template, is_active: true }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchSettingsTemplates(productA)
    useAppStore.setState({ currentProduct: null })

    await useAppStore.getState().activateSettingsTemplate(productA, settingsTemplateA)

    expect(productGets).toBe(2)
    expect(useAppStore.getState().currentProduct?.global_style_settings).toEqual(settings)
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

  it('omits app cookies when uploading to a signed storage URL', async () => {
    const signedUrl = 'https://storage.example.test/signed-upload'
    let signedUploadInit: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (
        url === `/api/products/${productA}/reference-sets/${referenceSetA}/images/upload-urls` &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { files?: Array<{ clientId: string }> }
        return Promise.resolve(jsonResponse([{
          clientId: body.files?.[0]?.clientId,
          signedUrl,
          storage_path: 'references/photo.png',
          file_name: 'photo.png',
          mime_type: 'image/png',
          file_size: 1,
          display_order: 1,
        }]))
      }
      if (url === signedUrl && method === 'PUT') {
        signedUploadInit = init
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (
        url === `/api/products/${productA}/reference-sets/${referenceSetA}/images` &&
        method === 'POST'
      ) {
        return Promise.resolve(jsonResponse([]))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore
      .getState()
      .uploadReferenceImages(productA, referenceSetA, [
        new File(['x'], 'photo.png', { type: 'image/png' }),
      ])

    expect(signedUploadInit).toEqual(
      expect.objectContaining({ method: 'PUT', credentials: 'omit' })
    )
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

  it('rejects malformed generation start responses without adding a job', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/products/${productA}/generate` && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore.getState().startGeneration(productA, {
        prompt_text: 'Make a product image',
        reference_sets: [],
      })
    ).rejects.toThrow('Failed to start generation')
    expect(useAppStore.getState().generationJobs).toEqual([])
  })

  it('preserves generation job identities when polling returns unchanged data', async () => {
    const job = makeGenerationJob()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate`) {
        return Promise.resolve(jsonResponse([job]))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGenerationJobs(productA)
    const firstJobs = useAppStore.getState().generationJobs
    const firstJob = firstJobs[0]

    await useAppStore.getState().fetchGenerationJobs(productA)

    expect(useAppStore.getState().generationJobs).toBe(firstJobs)
    expect(useAppStore.getState().generationJobs[0]).toBe(firstJob)
  })

  it('loads generation history incrementally from the paginated jobs endpoint', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      makeGenerationJob({ id: `job-${index}` })
    )
    const secondPage = [
      makeGenerationJob({ id: 'job-50' }),
      makeGenerationJob({ id: 'job-51' }),
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate`) {
        return Promise.resolve(jsonResponse(firstPage))
      }
      if (url === `/api/products/${productA}/generate?limit=50&offset=50`) {
        return Promise.resolve(jsonResponse(secondPage))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGenerationJobs(productA)
    expect(useAppStore.getState().generationJobs).toHaveLength(50)
    expect(useAppStore.getState().generationJobsHasMore).toBe(true)

    await useAppStore.getState().fetchGenerationJobsMore(productA)

    expect(useAppStore.getState().generationJobs).toHaveLength(52)
    expect(useAppStore.getState().generationJobs.slice(-2).map((job) => job.id)).toEqual([
      'job-50',
      'job-51',
    ])
    expect(useAppStore.getState().generationJobsHasMore).toBe(false)
    expect(useAppStore.getState().loadingJobsMore).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/products/${productA}/generate?limit=50&offset=50`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('preserves current job and image identities when status polling is unchanged', async () => {
    const job = makeGenerationJob()
    const image = makeGeneratedImage()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate/${generationJobA}`) {
        return Promise.resolve(jsonResponse({ job, images: [image] }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchJobStatus(productA, generationJobA)
    const firstCurrentJob = useAppStore.getState().currentJob
    const firstImages = firstCurrentJob?.images
    const firstImage = firstImages?.[0]

    await useAppStore.getState().fetchJobStatus(productA, generationJobA)

    expect(useAppStore.getState().currentJob).toBe(firstCurrentJob)
    expect(useAppStore.getState().currentJob?.images).toBe(firstImages)
    expect(useAppStore.getState().currentJob?.images?.[0]).toBe(firstImage)
  })

  it('reconciles a queue clear without re-fetching matching generation jobs', async () => {
    const pendingJob = makeGenerationJob({
      status: 'pending',
      completed_count: 0,
      completed_at: null,
    })
    const completedJob = makeGenerationJob({ id: generationJobB })
    let generationGets = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate` && method === 'GET') {
        generationGets += 1
        return Promise.resolve(jsonResponse([pendingJob, completedJob]))
      }
      if (url === `/api/products/${productA}/generate` && method === 'DELETE') {
        return Promise.resolve(jsonResponse({ cancelled: 1, cleared_failed: 0, cleared_log: 0 }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGenerationJobs(productA)
    await useAppStore.getState().clearGenerationQueue(productA)

    expect(generationGets).toBe(1)
    expect(useAppStore.getState().generationJobs).toEqual([
      expect.objectContaining({
        id: generationJobA,
        status: 'cancelled',
        error_message: 'Cancelled by user',
        completed_at: expect.any(String),
      }),
      completedJob,
    ])
  })

  it('removes cleared failures without re-fetching matching generation jobs', async () => {
    const failedJob = makeGenerationJob({ status: 'failed' })
    const completedJob = makeGenerationJob({ id: generationJobB })
    let generationGets = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate` && method === 'GET') {
        generationGets += 1
        return Promise.resolve(jsonResponse([failedJob, completedJob]))
      }
      if (url === `/api/products/${productA}/generate?scope=failed` && method === 'DELETE') {
        return Promise.resolve(jsonResponse({ cancelled: 0, cleared_failed: 1, cleared_log: 0 }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGenerationJobs(productA)
    await useAppStore.getState().clearGenerationFailures(productA)

    expect(generationGets).toBe(1)
    expect(useAppStore.getState().generationJobs).toEqual([completedJob])
  })

  it('re-fetches generation jobs when a clear response does not match the client snapshot', async () => {
    const pendingJob = makeGenerationJob({ status: 'pending' })
    const completedJob = makeGenerationJob({ id: generationJobB })
    let generationGets = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productA}/generate` && method === 'GET') {
        generationGets += 1
        return Promise.resolve(jsonResponse(generationGets === 1 ? [pendingJob] : [completedJob]))
      }
      if (url === `/api/products/${productA}/generate` && method === 'DELETE') {
        return Promise.resolve(jsonResponse({ cancelled: 0, cleared_failed: 0, cleared_log: 0 }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGenerationJobs(productA)
    await useAppStore.getState().clearGenerationQueue(productA)

    expect(generationGets).toBe(2)
    expect(useAppStore.getState().generationJobs).toEqual([completedJob])
  })

  it('does not let a late generation-log clear invalidate a new current-job fetch', async () => {
    const jobA = makeGenerationJob()
    const jobB = makeGenerationJob({
      id: generationJobB,
      product_id: productB,
    })
    const pendingClearLog = deferred<Response>()
    const pendingJobB = deferred<Response>()

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      if (url === `/api/products/${productA}/generate/${generationJobA}`) {
        return Promise.resolve(jsonResponse({ job: jobA, images: [] }))
      }
      if (url === `/api/products/${productB}/generate/${generationJobB}`) {
        return pendingJobB.promise
      }
      if (url === `/api/products/${productA}/generate?scope=log` && method === 'DELETE') {
        return pendingClearLog.promise
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchJobStatus(productA, generationJobA)
    expect(useAppStore.getState().currentJob?.id).toBe(generationJobA)

    const clearLogPromise = useAppStore.getState().clearGenerationLog(productA)
    await useAppStore.getState().fetchProduct(productB)
    const jobBPromise = useAppStore.getState().fetchJobStatus(productB, generationJobB)

    pendingClearLog.resolve(jsonResponse({ success: true }))
    await clearLogPromise

    pendingJobB.resolve(jsonResponse({ job: jobB, images: [] }))
    await jobBPromise

    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().currentJob?.id).toBe(generationJobB)
  })

  it('clears stale error-log loading when project navigation supersedes a pending fetch', async () => {
    const pendingErrorLogsA = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/error-logs?project_id=${productA}`) {
        return pendingErrorLogsA.promise
      }
      if (url === `/api/projects/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Project B' }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    const errorLogsPromise = useAppStore.getState().fetchErrorLogs(productA)
    expect(useAppStore.getState().loadingErrorLogs).toBe(true)

    await useAppStore.getState().fetchProject(productB)
    expect(useAppStore.getState().currentProject?.id).toBe(productB)
    expect(useAppStore.getState().errorLogs).toEqual([])
    expect(useAppStore.getState().loadingErrorLogs).toBe(false)

    pendingErrorLogsA.resolve(jsonResponse([{
      id: '99999999-9999-4999-8999-999999999999',
      project_id: productA,
      product_id: null,
      error_message: 'Old project error',
      error_source: null,
      error_context: null,
      created_at: '2026-07-06T00:00:00.000Z',
    }]))
    await errorLogsPromise

    expect(useAppStore.getState().errorLogs).toEqual([])
    expect(useAppStore.getState().loadingErrorLogs).toBe(false)
  })

  it('rejects malformed image update responses without mutating gallery state', async () => {
    const image: GeneratedImage = {
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
    useAppStore.setState({ galleryImages: [image] })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/images/${generatedImageA}` && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ image: null }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore.getState().updateImageApproval(generatedImageA, 'approved')
    ).rejects.toThrow('Failed to update image')
    expect(useAppStore.getState().galleryImages).toEqual([image])
  })

  it('does not rebuild the current job when an approval update targets another image', async () => {
    const galleryImage = makeGeneratedImage()
    const currentJobImage = makeGeneratedImage({
      id: generatedImageB,
      storage_path: 'images/b.png',
    })
    const currentJob = { ...makeGenerationJob(), images: [currentJobImage] }
    useAppStore.setState({ galleryImages: [galleryImage], currentJob })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/images/${generatedImageA}` && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({
          image: { id: generatedImageA, approval_status: 'approved' },
        }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().updateImageApproval(generatedImageA, 'approved')

    expect(useAppStore.getState().galleryImages[0].approval_status).toBe('approved')
    expect(useAppStore.getState().currentJob).toBe(currentJob)
    expect(useAppStore.getState().currentJob?.images).toBe(currentJob.images)
  })

  it.each([
    {
      name: 'approval update',
      method: 'PATCH',
      url: `/api/images/${generatedImageA}`,
      start: () => useAppStore.getState().updateImageApproval(generatedImageA, 'approved'),
      response: () => jsonResponse({ image: { id: generatedImageA, approval_status: 'approved' } }),
    },
    {
      name: 'image delete',
      method: 'DELETE',
      url: `/api/images/${generatedImageA}`,
      start: () => useAppStore.getState().deleteImage(generatedImageA),
      response: () => jsonResponse({ success: true }),
    },
    {
      name: 'bulk image delete',
      method: 'POST',
      url: '/api/images/bulk-delete',
      start: () => useAppStore.getState().bulkDeleteImages([generatedImageA]),
      response: () => jsonResponse({ success: true }),
    },
  ])('does not let a late $name invalidate a new gallery fetch', async (testCase) => {
    const imageA = makeGeneratedImage()
    const imageB = makeGeneratedImage({
      id: generatedImageB,
      storage_path: 'images/b.png',
    })
    const pendingMutation = deferred<Response>()
    const pendingGalleryB = deferred<Response>()

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === `/api/products/${productA}`) {
        return Promise.resolve(jsonResponse({ id: productA, name: 'Product A' }))
      }
      if (url === `/api/products/${productB}`) {
        return Promise.resolve(jsonResponse({ id: productB, name: 'Product B' }))
      }
      if (url.startsWith(`/api/products/${productA}/gallery?`)) {
        return Promise.resolve(jsonResponse({ images: [imageA], total: 1, has_more: false }))
      }
      if (url.startsWith(`/api/products/${productB}/gallery?`)) {
        return pendingGalleryB.promise
      }
      if (url === testCase.url && method === testCase.method) {
        return pendingMutation.promise
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await useAppStore.getState().fetchProduct(productA)
    await useAppStore.getState().fetchGallery(productA)
    expect(useAppStore.getState().galleryImages).toEqual([imageA])

    const mutationPromise = testCase.start()
    await useAppStore.getState().fetchProduct(productB)
    const galleryBPromise = useAppStore.getState().fetchGallery(productB)

    pendingMutation.resolve(testCase.response())
    await mutationPromise

    pendingGalleryB.resolve(jsonResponse({ images: [imageB], total: 1, has_more: false }))
    await galleryBPromise

    expect(useAppStore.getState().currentProduct?.id).toBe(productB)
    expect(useAppStore.getState().galleryImages).toEqual([imageB])
    expect(useAppStore.getState().galleryTotal).toBe(1)
    expect(useAppStore.getState().loadingGallery).toBe(false)
  })

  it('clears ai loading when build-prompt returns malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/ai/build-prompt' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ refined_prompt: null }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore.getState().buildPrompt(productA, 'make it brighter')
    ).rejects.toThrow('Failed to build prompt')
    expect(useAppStore.getState().aiLoading).toBe(false)
  })

  it('rejects malformed prompt suggestions with a stable error', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/ai/suggest-prompts' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ prompts: [{ name: 'Idea', prompt_text: null }] }))
      }
      return Promise.resolve(jsonResponse({ error: 'Unexpected request' }, 500))
    }))

    await expect(
      useAppStore.getState().suggestPrompts(productA, 1)
    ).rejects.toThrow('Failed to suggest prompts')
    expect(useAppStore.getState().aiLoading).toBe(false)
  })

  it('times out a hanging AI request and clears its loading state', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    ))

    const request = useAppStore.getState().buildPrompt(productA, 'make it brighter')
    const rejection = expect(request).rejects.toThrow('Request timed out')

    await vi.advanceTimersByTimeAsync(60_000)
    await rejection

    expect(useAppStore.getState().aiLoading).toBe(false)
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
