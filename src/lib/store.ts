'use client'

import { create } from 'zustand'
import type {
  Project,
  Product,
  ReferenceSet,
  ReferenceImage,
  PromptTemplate,
  GenerationJob,
  GeneratedImage,
  SettingsTemplate,
  GlobalStyleSettings,
  ErrorLog,
} from './types'
import {
  optionalUuid,
  requireUuid,
  sanitizeApprovalStatus,
  sanitizeGalleryFilters,
  sanitizePromptText,
  sanitizePublicErrorMessage,
  sanitizeUuidArray,
  validateReferenceUploadFiles,
} from './request-guards'

const DEFAULT_ERROR_MESSAGE = 'Request failed'
const MAX_SUGGESTED_PROMPT_COUNT = 10
const MAX_API_RETRIES = 2
const MAX_UPLOAD_RETRIES = 1
const GALLERY_PAGE_SIZE = 48
const RETRYABLE_RESPONSE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const requestVersions = new Map<string, number>()
const successfulRequests = new Set<string>()
const inFlightRequests = new Map<string, Promise<unknown>>()
const sliceScopes = new Map<string, string>()
let aiRequestCount = 0

const sanitizePathSegment = (value: string) => encodeURIComponent(value.trim())

const buildApiPath = (...segments: string[]) =>
  segments.map((segment) => sanitizePathSegment(segment)).join('/')

const normalizeLabelInput = (value: string) => value.trim().replace(/\s+/g, ' ')
const trimTextInput = (value: string) => value.trim()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const buildRequestKey = (scope: string, ...parts: Array<string | undefined | null>) =>
  [scope, ...parts.map((part) => (part ?? '').trim() || '_')].join(':')

const updateSliceScope = (slice: string, scope: string) => {
  const normalizedScope = scope.trim() || '_'
  const previousScope = sliceScopes.get(slice)
  sliceScopes.set(slice, normalizedScope)
  return previousScope !== normalizedScope
}

const isCurrentSliceScope = (slice: string, scope: string) =>
  (sliceScopes.get(slice) ?? '_') === (scope.trim() || '_')

const buildProjectScopedQuery = (projectId: string) => {
  const params = new URLSearchParams()
  params.set('project_id', projectId.trim())
  return params.toString()
}

const sanitizeStringArray = (values: string[]) =>
  Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )

const clampInteger = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

const beginTrackedRequest = (key: string) => {
  const version = (requestVersions.get(key) ?? 0) + 1
  requestVersions.set(key, version)
  return version
}

const invalidateTrackedRequest = (key: string) => {
  const version = (requestVersions.get(key) ?? 0) + 1
  requestVersions.set(key, version)
  inFlightRequests.delete(key)
  return version
}

const isLatestRequest = (key: string, version: number) =>
  (requestVersions.get(key) ?? 0) === version

const markRequestSuccessful = (key: string) => {
  successfulRequests.add(key)
}

const shouldPreserveStateOnFetchError = (key: string) => successfulRequests.has(key)

const invalidateRequestKeys = (...keys: Array<string | undefined | null>) => {
  for (const key of keys) {
    if (key) invalidateTrackedRequest(key)
  }
}

const getActiveSliceScope = (slice: string) => {
  const scope = sliceScopes.get(slice)
  if (!scope || scope === '_') return null
  return scope
}

const extractErrorMessage = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const message = value.trim().replace(/\s+/g, ' ')
  if (!message) return null
  return message.slice(0, 200)
}

const isRetryableNetworkError = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && error.name === 'AbortError')

const withRetry = async (
  request: () => Promise<Response>,
  options: {
    retries: number
    shouldRetryResponse?: (response: Response) => boolean
    shouldRetryError?: (error: unknown) => boolean
  }
) => {
  let attempt = 0
  let response: Response | null = null

  while (attempt <= options.retries) {
    try {
      response = await request()
      if (!options.shouldRetryResponse?.(response) || attempt === options.retries) {
        return response
      }
    } catch (error) {
      if (!options.shouldRetryError?.(error) || attempt === options.retries) {
        throw error
      }
    }

    attempt += 1
    await wait(250 * attempt)
  }

  return response as Response
}

const uploadToSignedUrl = (signedUrl: string, file: File) =>
  withRetry(
    () =>
      fetch(signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      }),
    {
      retries: MAX_UPLOAD_RETRIES,
      shouldRetryResponse: (response) => !response.ok && RETRYABLE_RESPONSE_STATUSES.has(response.status),
      shouldRetryError: isRetryableNetworkError,
    }
  )

const safeParseResponse = async (res: Response) => {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return res.json().catch(() => null)
  }

  const text = await res.text().catch(() => '')
  return text ? { error: text } : null
}

const logStoreError = (scope: string, error: unknown) => {
  console.error(`[Store:${scope}] ${sanitizePublicErrorMessage(error)}`)
}

const getInFlightRequest = <T>(key: string, request: () => Promise<T>) => {
  const existingRequest = inFlightRequests.get(key) as Promise<T> | undefined
  if (existingRequest) return existingRequest

  const nextRequest = request().finally(() => {
    if (inFlightRequests.get(key) === nextRequest) {
      inFlightRequests.delete(key)
    }
  })

  inFlightRequests.set(key, nextRequest)
  return nextRequest
}

const mergeUpdatedImage = (images: GeneratedImage[], imageId: string, updated: Partial<GeneratedImage>) => {
  let didChange = false
  const nextImages = images.map((image) => {
    if (image.id !== imageId) return image
    didChange = true
    return { ...image, ...updated }
  })

  return didChange ? nextImages : images
}

const removeImagesById = (images: GeneratedImage[], ids: Set<string>) => {
  const nextImages = images.filter((image) => !ids.has(image.id))
  return nextImages.length === images.length ? images : nextImages
}

const getProductScopedState = () => ({
  referenceSets: [],
  referenceImages: {},
  promptTemplates: [],
  generationJobs: [],
  currentJob: null,
  galleryImages: [],
  galleryTotal: 0,
  galleryHasMore: false,
  loadingGalleryMore: false,
  settingsTemplates: [],
})

const updateGalleryStateAfterRemoval = (state: Pick<AppState, 'galleryImages' | 'galleryTotal'>, ids: Set<string>) => {
  const galleryImages = removeImagesById(state.galleryImages, ids)
  const removedCount = state.galleryImages.length - galleryImages.length
  const galleryTotal = Math.max(0, state.galleryTotal - removedCount)

  return {
    galleryImages,
    galleryTotal,
    galleryHasMore: galleryTotal > galleryImages.length,
  }
}

const getGalleryQueryString = (
  filters?: {
    job_id?: string
    approval_status?: string
    media_type?: string
    scene_id?: string
    sort?: string
  },
  offset = 0
) => {
  const params = new URLSearchParams()
  if (filters?.job_id) params.set('job_id', filters.job_id.trim())
  if (filters?.approval_status) params.set('approval_status', filters.approval_status.trim())
  if (filters?.media_type) params.set('media_type', filters.media_type.trim())
  if (filters?.scene_id) params.set('scene_id', filters.scene_id.trim())
  if (filters?.sort) params.set('sort', filters.sort.trim())
  params.set('limit', String(GALLERY_PAGE_SIZE))
  params.set('offset', String(offset))
  return params.toString()
}

const getGalleryRequestKey = (
  productId: string,
  filters?: {
    job_id?: string
    approval_status?: string
    media_type?: string
    scene_id?: string
    sort?: string
  }
) => buildRequestKey('gallery', productId, getGalleryQueryString(filters))

const beginAiRequest = (set: (partial: Partial<AppState>) => void) => {
  aiRequestCount += 1
  if (aiRequestCount === 1) {
    set({ aiLoading: true })
  }
}

const endAiRequest = (set: (partial: Partial<AppState>) => void) => {
  aiRequestCount = Math.max(0, aiRequestCount - 1)
  if (aiRequestCount === 0) {
    set({ aiLoading: false })
  }
}

const getGalleryQueryString = (
  filters?: {
    job_id?: string
    approval_status?: string
    media_type?: string
    scene_id?: string
  }
) => {
  const params = new URLSearchParams()
  if (filters?.job_id) params.set('job_id', filters.job_id.trim())
  if (filters?.approval_status) params.set('approval_status', filters.approval_status.trim())
  if (filters?.media_type) params.set('media_type', filters.media_type.trim())
  if (filters?.scene_id) params.set('scene_id', filters.scene_id.trim())
  return params.toString()
}

interface AppState {
  // Projects
  projects: Project[]
  currentProject: Project | null
  loadingProjects: boolean
  fetchProjects: () => Promise<void>
  fetchProject: (id: string) => Promise<void>
  createProject: (data: { name: string; description?: string }) => Promise<Project>
  updateProject: (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'global_style_settings'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>

  // Products
  products: Product[]
  currentProduct: Product | null
  loadingProducts: boolean
  fetchProducts: (projectId?: string) => Promise<void>
  fetchProduct: (id: string) => Promise<void>
  createProduct: (data: { name: string; description?: string; project_id: string }) => Promise<Product>
  updateProduct: (id: string, data: Partial<Pick<Product, 'name' | 'description' | 'global_style_settings' | 'project_id'>>) => Promise<void>
  deleteProduct: (id: string) => Promise<void>

  // Reference Sets
  referenceSets: ReferenceSet[]
  loadingRefSets: boolean
  fetchReferenceSets: (productId: string) => Promise<void>
  createReferenceSet: (productId: string, data: { name: string; description?: string; type?: 'product' | 'texture' }) => Promise<ReferenceSet>
  updateReferenceSet: (productId: string, setId: string, data: Partial<Pick<ReferenceSet, 'name' | 'description' | 'is_active'>>) => Promise<void>
  deleteReferenceSet: (productId: string, setId: string) => Promise<void>

  // Reference Images
  referenceImages: Record<string, ReferenceImage[]> // keyed by set ID
  fetchReferenceImages: (productId: string, setId: string) => Promise<void>
  uploadReferenceImages: (productId: string, setId: string, files: File[]) => Promise<void>
  deleteReferenceImage: (productId: string, setId: string, imgId: string) => Promise<void>

  // Prompt Templates
  promptTemplates: PromptTemplate[]
  fetchPromptTemplates: (productId: string) => Promise<void>
  createPromptTemplate: (productId: string, data: { name: string; prompt_text: string; tags?: string[]; prompt_type?: 'image' | 'video' }) => Promise<PromptTemplate>
  updatePromptTemplate: (productId: string, promptId: string, data: Partial<Pick<PromptTemplate, 'name' | 'prompt_text' | 'tags'>>) => Promise<void>
  deletePromptTemplate: (productId: string, promptId: string) => Promise<void>

  // Generation
  generationJobs: GenerationJob[]
  currentJob: (GenerationJob & { images?: GeneratedImage[] }) | null
  loadingJobs: boolean
  fetchGenerationJobs: (productId: string) => Promise<void>
  startGeneration: (productId: string, data: {
    prompt_template_id?: string
    prompt_text: string
    variation_count?: number
    resolution?: string
    aspect_ratio?: string
    reference_set_id?: string
    texture_set_id?: string
    product_image_count?: number
    texture_image_count?: number
    source_image_id?: string
    lens?: string
    camera_height?: string
    lighting?: string
    color_grading?: string
    style?: string
  }) => Promise<GenerationJob>
  fetchJobStatus: (productId: string, jobId: string) => Promise<void>
  retryGenerationJob: (productId: string, jobId: string) => Promise<GenerationJob>
  clearGenerationQueue: (productId: string) => Promise<void>
  clearGenerationFailures: (productId: string) => Promise<void>
  deleteGenerationJob: (productId: string, jobId: string) => Promise<void>
  clearGenerationLog: (productId: string) => Promise<void>
  devParallelGeneration: boolean
  setDevParallelGeneration: (enabled: boolean) => void

  // Gallery
  galleryImages: GeneratedImage[]
  galleryTotal: number
  galleryHasMore: boolean
  loadingGallery: boolean
  loadingGalleryMore: boolean
  fetchGallery: (productId: string, filters?: { job_id?: string; approval_status?: string; media_type?: string; scene_id?: string; sort?: string }) => Promise<void>
  fetchGalleryMore: (productId: string, filters?: { job_id?: string; approval_status?: string; media_type?: string; scene_id?: string; sort?: string }) => Promise<void>
  updateImageApproval: (imageId: string, approval_status: string | null, notes?: string) => Promise<void>
  deleteImage: (imageId: string) => Promise<void>
  bulkDeleteImages: (imageIds: string[]) => Promise<void>

  // Settings Templates
  settingsTemplates: SettingsTemplate[]
  loadingSettingsTemplates: boolean
  fetchSettingsTemplates: (productId: string) => Promise<void>
  createSettingsTemplate: (productId: string, data: { name: string; settings: GlobalStyleSettings }) => Promise<SettingsTemplate>
  updateSettingsTemplate: (productId: string, templateId: string, data: Partial<Pick<SettingsTemplate, 'name' | 'settings' | 'is_active'>>) => Promise<void>
  deleteSettingsTemplate: (productId: string, templateId: string) => Promise<void>
  activateSettingsTemplate: (productId: string, templateId: string) => Promise<void>

  // Error Logs
  errorLogs: ErrorLog[]
  loadingErrorLogs: boolean
  fetchErrorLogs: (projectId: string) => Promise<void>
  clearErrorLogs: (projectId: string) => Promise<void>

  // AI
  aiLoading: boolean
  buildPrompt: (productId: string, userPrompt: string) => Promise<string>
  suggestPrompts: (productId: string, count?: number) => Promise<{ name: string; prompt_text: string }[]>
}

const api = async (url: string, options?: RequestInit) => {
  const method = (options?.method ?? 'GET').toUpperCase()
  let res: Response

  try {
    res = await withRetry(
      () => fetch(url, options),
      {
        retries: method === 'GET' ? MAX_API_RETRIES : 0,
        shouldRetryResponse: (response) => !response.ok && RETRYABLE_RESPONSE_STATUSES.has(response.status),
        shouldRetryError: isRetryableNetworkError,
      }
    )
  } catch (error) {
    throw new Error(
      extractErrorMessage(error instanceof Error ? error.message : null) || DEFAULT_ERROR_MESSAGE
    )
  }

  if (!res.ok) {
    const err = await safeParseResponse(res)
    const message =
      extractErrorMessage(
        err && typeof err === 'object' && 'error' in err ? err.error : null
      ) ||
      extractErrorMessage(
        err && typeof err === 'object' && 'message' in err ? err.message : null
      ) ||
      extractErrorMessage(res.statusText) ||
      DEFAULT_ERROR_MESSAGE

    throw new Error(message)
  }

  const data = await safeParseResponse(res)
  return data ?? null
}

const getDevParallelDefault = () => {
  if (typeof window === 'undefined') return true
  const stored = window.localStorage.getItem('devParallelGeneration')
  if (stored === null) return true
  return stored === 'true'
}

export const useAppStore = create<AppState>((set, get) => ({
  devParallelGeneration: getDevParallelDefault(),
  setDevParallelGeneration: (enabled) => {
    set({ devParallelGeneration: enabled })
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('devParallelGeneration', String(enabled))
    }
  },
  // Projects
  projects: [],
  currentProject: null,
  loadingProjects: false,
  fetchProjects: async () => {
    const requestKey = buildRequestKey('projects')
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingProjects: true })
    try {
      const data = await getInFlightRequest(requestKey, () => api('/api/projects'))
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ projects: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ projects: [] })
      }
      logStoreError('Projects', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingProjects: false })
      }
    }
  },
  fetchProject: async (id) => {
    const projectId = requireUuid(id, 'project id')
    if (updateSliceScope('currentProject', projectId)) {
      set({ currentProject: null, errorLogs: [] })
    }
    const requestKey = buildRequestKey('currentProject', projectId)
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await getInFlightRequest(requestKey, () => api(`/api/projects/${buildApiPath(projectId)}`))
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ currentProject: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ currentProject: null })
      }
      logStoreError('Project', error)
    }
  },
  createProject: async (data) => {
    const project = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: normalizeLabelInput(data.name),
        description: data.description ? trimTextInput(data.description) : undefined,
      }),
    })
    invalidateRequestKeys(buildRequestKey('projects'))
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },
  updateProject: async (id, data) => {
    const projectId = requireUuid(id, 'project id')
    const project = await api(`/api/projects/${buildApiPath(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
      }),
    })
    invalidateRequestKeys(buildRequestKey('projects'), buildRequestKey('currentProject', projectId))
    set((s) => ({
      currentProject: s.currentProject?.id === projectId ? project : s.currentProject,
      projects: s.projects.map((p) => (p.id === projectId ? project : p)),
    }))
  },
  deleteProject: async (id) => {
    const projectId = requireUuid(id, 'project id')
    await api(`/api/projects/${buildApiPath(projectId)}`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('projects'), buildRequestKey('currentProject', projectId))
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      currentProject: s.currentProject?.id === projectId ? null : s.currentProject,
    }))
  },

  // Products
  products: [],
  currentProduct: null,
  loadingProducts: false,
  fetchProducts: async (projectId) => {
    const scopedProjectId = optionalUuid(projectId, 'project id')
    const scopeToken = scopedProjectId ?? '_'
    if (updateSliceScope('products', scopeToken)) {
      set({ products: [] })
    }
    const requestKey = buildRequestKey('products', scopedProjectId)
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingProducts: true })
    try {
      const params = new URLSearchParams()
      if (scopedProjectId) params.set('project_id', scopedProjectId)
      const qs = params.toString()
      const data = await getInFlightRequest(requestKey, () => api(`/api/products${qs ? `?${qs}` : ''}`))
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ products: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ products: [] })
      }
      logStoreError('Products', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingProducts: false })
      }
    }
  },
  fetchProduct: async (id) => {
    const productId = requireUuid(id, 'product id')
    if (updateSliceScope('currentProduct', productId)) {
      set({ currentProduct: null, ...getProductScopedState() })
    }
    const requestKey = buildRequestKey('currentProduct', productId)
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await getInFlightRequest(requestKey, () => api(`/api/products/${buildApiPath(productId)}`))
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ currentProduct: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ currentProduct: null })
      }
      logStoreError('Product', error)
    }
  },
  createProduct: async (data) => {
    const projectId = requireUuid(data.project_id, 'project id')
    const product = await api('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        description: data.description ? trimTextInput(data.description) : undefined,
        project_id: projectId,
      }),
    })
    invalidateRequestKeys(buildRequestKey('products', projectId))
    set((s) => ({ products: [product, ...s.products] }))
    return product
  },
  updateProduct: async (id, data) => {
    const productId = requireUuid(id, 'product id')
    const nextProjectId = optionalUuid(data.project_id, 'project id')
    const existingProduct = get().products.find((product) => product.id === productId)
    const product = await api(`/api/products/${buildApiPath(productId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
        project_id: nextProjectId,
      }),
    })
    invalidateRequestKeys(
      buildRequestKey('currentProduct', productId),
      buildRequestKey('products', existingProduct?.project_id),
      buildRequestKey('products', nextProjectId ?? existingProduct?.project_id)
    )
    set((s) => ({
      currentProduct: s.currentProduct?.id === productId ? product : s.currentProduct,
      products: s.products.map((p) => (p.id === productId ? product : p)),
    }))
  },
  deleteProduct: async (id) => {
    const productId = requireUuid(id, 'product id')
    const existingProduct = get().products.find((product) => product.id === productId)
    await api(`/api/products/${buildApiPath(productId)}`, { method: 'DELETE' })
    invalidateRequestKeys(
      buildRequestKey('currentProduct', productId),
      buildRequestKey('products', existingProduct?.project_id)
    )
    set((s) => ({
      products: s.products.filter((p) => p.id !== productId),
      currentProduct: s.currentProduct?.id === productId ? null : s.currentProduct,
      ...(s.currentProduct?.id === productId ? getProductScopedState() : {}),
    }))
  },

  // Reference Sets
  referenceSets: [],
  loadingRefSets: false,
  fetchReferenceSets: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    if (updateSliceScope('referenceSets', scopedProductId)) {
      set({ referenceSets: [], referenceImages: {} })
    }
    const requestKey = buildRequestKey('referenceSets', scopedProductId)
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingRefSets: true })
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ referenceSets: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ referenceSets: [] })
      }
      logStoreError('ReferenceSets', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingRefSets: false })
      }
    }
  },
  createReferenceSet: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const refSet = await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        description: data.description ? trimTextInput(data.description) : undefined,
      }),
    })
    invalidateRequestKeys(buildRequestKey('referenceSets', scopedProductId))
    set((s) => ({ referenceSets: [...s.referenceSets, refSet] }))
    return refSet
  },
  updateReferenceSet: async (productId, setId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const refSet = await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
      }),
    })
    invalidateRequestKeys(buildRequestKey('referenceSets', scopedProductId))
    set((s) => ({
      referenceSets: s.referenceSets.map((r) =>
        r.id === referenceSetId ? refSet : data.is_active ? { ...r, is_active: false } : r
      ),
    }))
  },
  deleteReferenceSet: async (productId, setId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}`, { method: 'DELETE' })
    invalidateRequestKeys(
      buildRequestKey('referenceSets', scopedProductId),
      buildRequestKey('referenceImages', scopedProductId, referenceSetId)
    )
    set((s) => {
      const nextReferenceImages = { ...s.referenceImages }
      delete nextReferenceImages[referenceSetId]
      return {
        referenceSets: s.referenceSets.filter((r) => r.id !== referenceSetId),
        referenceImages: nextReferenceImages,
      }
    })
  },

  // Reference Images
  referenceImages: {},
  fetchReferenceImages: async (productId, setId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const requestKey = buildRequestKey('referenceImages', scopedProductId, referenceSetId)
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(
          `/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}/images`
        )
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set((s) => ({ referenceImages: { ...s.referenceImages, [referenceSetId]: data } }))
    } catch (error) {
      logStoreError('ReferenceImages', error)
    }
  },
  uploadReferenceImages: async (productId, setId, files) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const validatedFiles = validateReferenceUploadFiles(files)
    const referenceImagesRequestKey = buildRequestKey('referenceImages', scopedProductId, referenceSetId)
    const uploadSpecs = validatedFiles.map((file, index) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      clientId: `${index}-${Date.now()}`,
    }))

    const signed = await api(
      `/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}/images/upload-urls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: uploadSpecs }),
      }
    )

    const signedPayload = signed as Array<
      | {
          clientId: string
          signedUrl: string
          storage_path: string
          file_name: string
          mime_type: string
          file_size: number
          display_order: number
        }
      | { clientId: string; error: string }
    >

    const fileMap = new Map(uploadSpecs.map((spec, idx) => [spec.clientId, validatedFiles[idx]]))
    const uploadResultPromises = signedPayload.map(async (item) => {
      if (!('signedUrl' in item)) {
        return {
          clientId: item.clientId,
          storage_path: '',
          file_name: '',
          mime_type: '',
          file_size: 0,
          display_order: 0,
          error: item.error || 'Failed to sign upload',
        }
      }

      const file = fileMap.get(item.clientId)
      if (!file) {
        return {
          clientId: item.clientId,
          storage_path: '',
          file_name: item.file_name,
          mime_type: item.mime_type,
          file_size: item.file_size,
          display_order: item.display_order,
          error: 'Missing file data',
        }
      }

      try {
        const uploadResp = await uploadToSignedUrl(item.signedUrl, file)
        if (!uploadResp.ok) {
          return {
            clientId: item.clientId,
            storage_path: item.storage_path,
            file_name: item.file_name,
            mime_type: item.mime_type,
            file_size: item.file_size,
            display_order: item.display_order,
            error: `Upload failed (${uploadResp.status})`,
          }
        }
      } catch (error) {
        return {
          clientId: item.clientId,
          storage_path: item.storage_path,
          file_name: item.file_name,
          mime_type: item.mime_type,
          file_size: item.file_size,
          display_order: item.display_order,
          error:
            extractErrorMessage(error instanceof Error ? error.message : null) || 'Upload failed',
        }
      }

      return {
        clientId: item.clientId,
        storage_path: item.storage_path,
        file_name: item.file_name,
        mime_type: item.mime_type,
        file_size: item.file_size,
        display_order: item.display_order,
      }
    })

    const uploadResults = await Promise.all(uploadResultPromises)

    const successfulUploads = uploadResults.filter((u) => !u.error)
    let payload: Array<ReferenceImage & { error?: string; file?: string }> = []
    if (successfulUploads.length > 0) {
      const data = await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploads: successfulUploads }),
      })
      payload = data as Array<ReferenceImage & { error?: string; file?: string }>
    }

    const uploaded = payload.filter((img) => Boolean(img?.id))
    const errors = [
      ...uploadResults.filter((u) => u.error),
      ...payload.filter((img) => !img?.id && img?.error),
    ]
    set((s) => ({
      referenceImages: {
        ...s.referenceImages,
        [setId]: [...(s.referenceImages[setId] || []), ...uploaded],
      },
    }))
    invalidateRequestKeys(referenceImagesRequestKey)
    if (uploaded.length === 0 && errors.length > 0) {
      const firstError =
        errors[0] && typeof errors[0] === 'object' && 'error' in errors[0]
        ? (errors[0] as { error?: string }).error
          : null
      throw new Error(firstError || 'Upload failed')
    }
  },
  deleteReferenceImage: async (productId, setId, imgId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const imageId = requireUuid(imgId, 'reference image id')
    await api(
      `/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}/images/${buildApiPath(imageId)}`,
      { method: 'DELETE' }
    )
    invalidateRequestKeys(buildRequestKey('referenceImages', scopedProductId, referenceSetId))
    set((s) => ({
      referenceImages: {
        ...s.referenceImages,
        [referenceSetId]: (s.referenceImages[referenceSetId] || []).filter((i) => i.id !== imageId),
      },
    }))
  },

  // Prompt Templates
  promptTemplates: [],
  fetchPromptTemplates: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    if (updateSliceScope('promptTemplates', scopedProductId)) {
      set({ promptTemplates: [] })
    }
    const requestKey = buildRequestKey('promptTemplates', scopedProductId)
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/prompts`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ promptTemplates: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ promptTemplates: [] })
      }
      logStoreError('PromptTemplates', error)
    }
  },
  createPromptTemplate: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const tmpl = await api(`/api/products/${buildApiPath(scopedProductId)}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        prompt_text: sanitizePromptText(data.prompt_text, 'prompt_text'),
        tags: data.tags ? sanitizeStringArray(data.tags) : undefined,
      }),
    })
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    set((s) => ({ promptTemplates: [...s.promptTemplates, tmpl] }))
    return tmpl
  },
  updatePromptTemplate: async (productId, promptId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const promptTemplateId = requireUuid(promptId, 'prompt template id')
    const tmpl = await api(`/api/products/${buildApiPath(scopedProductId)}/prompts/${buildApiPath(promptTemplateId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        prompt_text:
          typeof data.prompt_text === 'string' ? sanitizePromptText(data.prompt_text, 'prompt_text') : data.prompt_text,
        tags: data.tags ? sanitizeStringArray(data.tags) : data.tags,
      }),
    })
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    set((s) => ({ promptTemplates: s.promptTemplates.map((p) => (p.id === promptTemplateId ? tmpl : p)) }))
  },
  deletePromptTemplate: async (productId, promptId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const promptTemplateId = requireUuid(promptId, 'prompt template id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/prompts/${buildApiPath(promptTemplateId)}`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    set((s) => ({ promptTemplates: s.promptTemplates.filter((p) => p.id !== promptTemplateId) }))
  },

  // Generation
  generationJobs: [],
  currentJob: null,
  loadingJobs: false,
  fetchGenerationJobs: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const requestKey = buildRequestKey('generationJobs', scopedProductId)
    if (updateSliceScope('generationJobs', requestKey)) {
      set({ generationJobs: [], currentJob: null, loadingJobs: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    const shouldShowLoading = get().generationJobs.length === 0
    if (shouldShowLoading) set({ loadingJobs: true })
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/generate`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ generationJobs: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ generationJobs: [] })
      }
      logStoreError('GenerationJobs', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion)) {
        set({ loadingJobs: false })
      }
    }
  },
  startGeneration: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const devParallel = get().devParallelGeneration
    const body = {
      ...data,
      prompt_text: sanitizePromptText(data.prompt_text, 'prompt_text'),
      prompt_template_id: optionalUuid(data.prompt_template_id, 'prompt template id') ?? null,
      reference_set_id: optionalUuid(data.reference_set_id, 'reference set id') ?? null,
      texture_set_id: optionalUuid(data.texture_set_id, 'texture set id') ?? null,
      source_image_id: optionalUuid(data.source_image_id, 'source image id') ?? null,
      variation_count: clampInteger(data.variation_count ?? 15, 1, 100, 15),
      ...(process.env.NODE_ENV === 'development' && !devParallel
        ? { parallelism_override: 1, batch_override: 1 }
        : {}),
    }
    const result = await api(`/api/products/${buildApiPath(scopedProductId)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const job = result.job ?? result
    invalidateRequestKeys(buildRequestKey('generationJobs', scopedProductId))
    set((s) => ({ generationJobs: [job, ...s.generationJobs] }))
    return job
  },
  fetchJobStatus: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    const requestKey = buildRequestKey('currentJob', scopedProductId, generationJobId)
    if (updateSliceScope('currentJob', requestKey)) {
      set({ currentJob: null })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ currentJob: { ...data.job, images: data.images } })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ currentJob: null })
      }
      logStoreError('CurrentJob', error)
    }
  },
  retryGenerationJob: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    const data = await api(`/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}/retry`, {
      method: 'POST',
    })
    const job = data.job ?? data
    invalidateRequestKeys(
      buildRequestKey('generationJobs', scopedProductId),
      buildRequestKey('currentJob', scopedProductId, generationJobId)
    )
    set((s) => ({
      generationJobs: [job, ...s.generationJobs.filter((j) => j.id !== job.id)],
      currentJob: s.currentJob?.id === job.id ? { ...job, images: s.currentJob?.images } : s.currentJob,
    }))
    return job
  },
  clearGenerationQueue: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('generationJobs', scopedProductId))
    await get().fetchGenerationJobs(scopedProductId)
  },
  clearGenerationFailures: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate?scope=failed`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('generationJobs', scopedProductId))
    await get().fetchGenerationJobs(scopedProductId)
  },
  deleteGenerationJob: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}`, { method: 'DELETE' })
    invalidateRequestKeys(
      buildRequestKey('generationJobs', scopedProductId),
      buildRequestKey('currentJob', scopedProductId, generationJobId)
    )
    set((s) => ({
      generationJobs: s.generationJobs.filter((j) => j.id !== generationJobId),
      currentJob: s.currentJob?.id === generationJobId ? null : s.currentJob,
    }))
  },
  clearGenerationLog: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate?scope=log`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('generationJobs', scopedProductId), getActiveSliceScope('currentJob'))
    set((s) => ({
      generationJobs: s.generationJobs.filter((j) => j.status === 'pending' || j.status === 'running'),
      currentJob:
        s.currentJob && (s.currentJob.status === 'completed' || s.currentJob.status === 'failed')
          ? null
          : s.currentJob,
    }))
  },

  // Gallery
  galleryImages: [],
  galleryTotal: 0,
  galleryHasMore: false,
  loadingGallery: false,
  loadingGalleryMore: false,
  fetchGallery: async (productId, filters) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const sanitizedFilters = sanitizeGalleryFilters(filters)
    const requestKey = getGalleryRequestKey(scopedProductId, sanitizedFilters)
    const qs = getGalleryQueryString(sanitizedFilters)
    if (updateSliceScope('gallery', requestKey)) {
      set({ galleryImages: [], galleryTotal: 0, galleryHasMore: false, loadingGallery: false, loadingGalleryMore: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    const shouldShowLoading = get().galleryImages.length === 0
    if (shouldShowLoading) set({ loadingGallery: true })
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/gallery?${qs}`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({
        galleryImages: data.images ?? data,
        galleryTotal: data.total ?? 0,
        galleryHasMore: data.has_more ?? false,
      })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ galleryImages: [], galleryTotal: 0, galleryHasMore: false })
      }
      logStoreError('Gallery', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion)) {
        set({ loadingGallery: false })
      }
    }
  },
  fetchGalleryMore: async (productId, filters) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const sanitizedFilters = sanitizeGalleryFilters(filters)
    const { galleryImages, galleryHasMore, loadingGalleryMore } = get()
    if (!galleryHasMore || loadingGalleryMore) return

    const requestKey = getGalleryRequestKey(scopedProductId, sanitizedFilters)
    const requestVersion = requestVersions.get(requestKey) ?? 0
    if (!isCurrentSliceScope('gallery', requestKey)) return

    set({ loadingGalleryMore: true })
    try {
      const qs = getGalleryQueryString(sanitizedFilters, galleryImages.length)
      const data = await api(`/api/products/${buildApiPath(scopedProductId)}/gallery?${qs}`)
      if (!isCurrentSliceScope('gallery', requestKey) || !isLatestRequest(requestKey, requestVersion)) {
        return
      }
      const newImages = data.images ?? []
      set((state) => {
        const existingIds = new Set(state.galleryImages.map((img) => img.id))
        const unique = newImages.filter((img: GeneratedImage) => !existingIds.has(img.id))
        return {
          galleryImages: [...state.galleryImages, ...unique],
          galleryTotal: data.total ?? state.galleryImages.length + unique.length,
          galleryHasMore: data.has_more ?? false,
        }
      })
    } catch (error) {
      logStoreError('GalleryMore', error)
    } finally {
      if (isCurrentSliceScope('gallery', requestKey)) {
        set({ loadingGalleryMore: false })
      }
    }
  },
  updateImageApproval: async (imageId, approval_status, notes) => {
    const scopedImageId = requireUuid(imageId, 'image id')
    const data = await api(`/api/images/${buildApiPath(scopedImageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approval_status: sanitizeApprovalStatus(approval_status, { allowNull: true }) ?? null,
        notes: typeof notes === 'string' ? trimTextInput(notes) : notes,
      }),
    })
    const updated = data.image ?? data
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGalleryScope) invalidateTrackedRequest(activeGalleryScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      galleryImages: mergeUpdatedImage(s.galleryImages, scopedImageId, updated),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: mergeUpdatedImage(s.currentJob.images, scopedImageId, updated),
          }
        : s.currentJob,
    }))
  },
  deleteImage: async (imageId) => {
    const scopedImageId = requireUuid(imageId, 'image id')
    await api(`/api/images/${buildApiPath(scopedImageId)}`, { method: 'DELETE' })
    const idSet = new Set([scopedImageId])
    invalidateRequestKeys(getActiveSliceScope('gallery'), getActiveSliceScope('currentJob'))
    set((s) => ({
      ...updateGalleryStateAfterRemoval(s, idSet),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: removeImagesById(s.currentJob.images, idSet),
          }
        : s.currentJob,
    }))
  },
  bulkDeleteImages: async (imageIds) => {
    const sanitizedIds = sanitizeUuidArray(imageIds, 'image id')
    await api('/api/images/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds: sanitizedIds }),
    })
    const idSet = new Set(sanitizedIds)
    invalidateRequestKeys(getActiveSliceScope('gallery'), getActiveSliceScope('currentJob'))
    set((s) => ({
      ...updateGalleryStateAfterRemoval(s, idSet),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: removeImagesById(s.currentJob.images, idSet),
          }
        : s.currentJob,
    }))
  },

  // Settings Templates
  settingsTemplates: [],
  loadingSettingsTemplates: false,
  fetchSettingsTemplates: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const requestKey = buildRequestKey('settingsTemplates', scopedProductId)
    if (updateSliceScope('settingsTemplates', requestKey)) {
      set({ settingsTemplates: [], loadingSettingsTemplates: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingSettingsTemplates: true })
    try {
      const data = await getInFlightRequest(requestKey, () =>
        api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates`)
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ settingsTemplates: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ settingsTemplates: [] })
      }
      logStoreError('SettingsTemplates', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingSettingsTemplates: false })
      }
    }
  },
  createSettingsTemplate: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const tmpl = await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
      }),
    })
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    set((s) => ({ settingsTemplates: [...s.settingsTemplates, tmpl] }))
    return tmpl
  },
  updateSettingsTemplate: async (productId, templateId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    const requestBody = {
      ...data,
      name: data.name ? normalizeLabelInput(data.name) : data.name,
    }
    const tmpl = await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    set((s) => ({
      settingsTemplates: s.settingsTemplates.map((t) =>
        t.id === settingsTemplateId ? tmpl : data.is_active ? { ...t, is_active: false } : t
      ),
    }))
  },
  deleteSettingsTemplate: async (productId, templateId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    await api(
      `/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`,
      { method: 'DELETE' }
    )
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    set((s) => ({ settingsTemplates: s.settingsTemplates.filter((t) => t.id !== settingsTemplateId) }))
  },
  activateSettingsTemplate: async (productId, templateId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    const tmpl = await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: true }),
    })
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    set((s) => ({
      settingsTemplates: s.settingsTemplates.map((t) =>
        t.id === settingsTemplateId ? tmpl : { ...t, is_active: false }
      ),
    }))
    // Refresh product to get synced settings
    await get().fetchProduct(scopedProductId)
  },

  // Error Logs
  errorLogs: [],
  loadingErrorLogs: false,
  fetchErrorLogs: async (projectId) => {
    const scopedProjectId = requireUuid(projectId, 'project id')
    if (updateSliceScope('errorLogs', scopedProjectId)) {
      set({ errorLogs: [] })
    }
    const requestKey = buildRequestKey('errorLogs', scopedProjectId)
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingErrorLogs: true })
    try {
      const qs = buildProjectScopedQuery(scopedProjectId)
      const data = await getInFlightRequest(requestKey, () => api(`/api/error-logs?${qs}`))
      if (!isLatestRequest(requestKey, requestVersion)) return
      markRequestSuccessful(requestKey)
      set({ errorLogs: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion) && !shouldPreserveStateOnFetchError(requestKey)) {
        set({ errorLogs: [] })
      }
      logStoreError('ErrorLogs', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingErrorLogs: false })
      }
    }
  },
  clearErrorLogs: async (projectId) => {
    const scopedProjectId = requireUuid(projectId, 'project id')
    const qs = buildProjectScopedQuery(scopedProjectId)
    await api(`/api/error-logs?${qs}`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('errorLogs', scopedProjectId))
    set({ errorLogs: [] })
  },

  // AI
  aiLoading: false,
  buildPrompt: async (productId, userPrompt) => {
    beginAiRequest(set)
    try {
      const data = await api('/api/ai/build-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: requireUuid(productId, 'product id'),
          user_prompt: sanitizePromptText(userPrompt, 'user_prompt'),
        }),
      })
      return data.refined_prompt
    } finally {
      endAiRequest(set)
    }
  },
  suggestPrompts: async (productId, count = 5) => {
    beginAiRequest(set)
    try {
      const data = await api('/api/ai/suggest-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: requireUuid(productId, 'product id'),
          count: clampInteger(count, 1, MAX_SUGGESTED_PROMPT_COUNT, 5),
        }),
      })
      return data.prompts
    } finally {
      endAiRequest(set)
    }
  },
}))
