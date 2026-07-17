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
import { logger } from '@/lib/logger'
import { isClientDevelopmentRuntime } from '@/lib/client-runtime'

const DEFAULT_ERROR_MESSAGE = 'Request failed'
const MAX_SUGGESTED_PROMPT_COUNT = 10
const MAX_API_RETRIES = 2
const MAX_UPLOAD_RETRIES = 1
const MAX_RETRY_AFTER_MS = 5_000
const API_REQUEST_TIMEOUT_MS = 15_000
const AI_REQUEST_TIMEOUT_MS = 60_000
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000
const GALLERY_PAGE_SIZE = 48
const RETRYABLE_RESPONSE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const requestVersions = new Map<string, number>()
const successfulRequests = new Set<string>()
const inFlightRequests = new Map<
  string,
  { controller: AbortController; promise: Promise<unknown> }
>()
const activeSliceRequests = new Map<string, string>()
const sliceScopes = new Map<string, string>()
let aiRequestCount = 0

type SignedReferenceUpload = {
  clientId: string
  signedUrl: string
  storage_path: string
  file_name: string
  mime_type: string
  file_size: number
  display_order: number
}

type FailedReferenceUpload = {
  clientId: string
  error: string
}

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

const isCurrentOrUntrackedSliceScope = (slice: string, scope: string) => {
  const currentScope = sliceScopes.get(slice)
  if (!currentScope || currentScope === '_') return true
  return currentScope === (scope.trim() || '_')
}

// A product-scoped slice's own scope is intentionally NOT reset when the active
// product changes (see fetchProduct — resetting it races with sibling page
// fetches and blanks the page). That leaves a window where a late fetch/create
// for product A could apply its result while the user is already on product B.
// Guard the apply step with this: only accept a product-scoped result if the
// active product is still A (or no product is tracked yet, e.g. in isolation).
const isActiveProductScope = (productId: string) =>
  isCurrentOrUntrackedSliceScope('currentProduct', productId)

const isCurrentProductScopedSlice = (slice: string, scope: string, productId: string) =>
  isCurrentOrUntrackedSliceScope(slice, scope) && isActiveProductScope(productId)

const clearProductScopedSliceScopes = () => {
  sliceScopes.set('referenceSets', '_')
  sliceScopes.set('promptTemplates', '_')
  sliceScopes.set('generationJobs', '_')
  sliceScopes.set('currentJob', '_')
  sliceScopes.set('gallery', '_')
  sliceScopes.set('settingsTemplates', '_')
}

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

const parseRetryAfterMs = (value: string | null) => {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000)
  }

  const retryAt = Date.parse(value)
  if (!Number.isNaN(retryAt)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAt - Date.now()))
  }

  return null
}

const getRetryDelayMs = (attempt: number, response: Response | null) =>
  parseRetryAfterMs(response?.headers.get('retry-after') ?? null) ?? 250 * attempt

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  options: RequestInit | undefined,
  timeoutMs: number
) => {
  const controller = new AbortController()
  const upstreamSignal = options?.signal
  let didTimeout = false
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)

  if (upstreamSignal?.aborted) {
    abortFromUpstream()
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(input, { ...options, signal: controller.signal })
  } catch (error) {
    if (didTimeout) {
      const timeoutError = new Error('Request timed out')
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

const beginTrackedRequest = (key: string) => {
  const version = (requestVersions.get(key) ?? 0) + 1
  requestVersions.set(key, version)
  return version
}

const invalidateTrackedRequest = (key: string) => {
  const version = (requestVersions.get(key) ?? 0) + 1
  requestVersions.set(key, version)
  inFlightRequests.get(key)?.controller.abort()
  inFlightRequests.delete(key)
  return version
}

const beginTrackedSliceRequest = (slice: string, key: string) => {
  const previousKey = activeSliceRequests.get(slice)
  if (previousKey && previousKey !== key) {
    invalidateTrackedRequest(previousKey)
  }
  activeSliceRequests.set(slice, key)
  return beginTrackedRequest(key)
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

const getActiveProductRequestScope = (slice: string, productId: string) => {
  const scope = getActiveSliceScope(slice)
  if (!scope) return null

  const productScope = buildRequestKey(slice, productId)
  return scope === productScope || scope.startsWith(`${productScope}:`) ? scope : null
}

const cancelProductScopedRequests = (productId: string) => {
  const cancelledSlices = new Set<string>()
  for (const slice of [
    'referenceSets',
    'promptTemplates',
    'generationJobs',
    'currentJob',
    'gallery',
    'settingsTemplates',
  ]) {
    const requestKey = activeSliceRequests.get(slice)
    const productPrefix = buildRequestKey(slice, productId)
    if (requestKey && (requestKey === productPrefix || requestKey.startsWith(`${productPrefix}:`))) {
      if (inFlightRequests.has(requestKey)) cancelledSlices.add(slice)
      invalidateTrackedRequest(requestKey)
    }
  }
  return cancelledSlices
}

const extractErrorMessage = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const message = value.trim().replace(/\s+/g, ' ')
  if (!message) return null
  return message.slice(0, 200)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const requireArrayResponse = <T>(value: unknown, message: string): T[] => {
  if (!Array.isArray(value)) {
    throw new Error(message)
  }
  return value as T[]
}

const requireRecordResponse = <T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
  message: string
): T => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as T
}

const requireEntityResponse = <T extends { id: string }>(value: unknown, message: string): T => {
  const record = requireRecordResponse(value, message)
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error(message)
  }
  return record as unknown as T
}

const getNestedRecordPayload = <T extends Record<string, unknown>>(
  value: unknown,
  property: string,
  message: string
): T => {
  const record = requireRecordResponse(value, message)
  const nested = record[property]
  if (nested === undefined) return record as T
  if (!isRecord(nested) || Array.isArray(nested)) {
    throw new Error(message)
  }
  return nested as T
}

const normalizeGalleryPayload = (value: unknown) => {
  const record = isRecord(value) && !Array.isArray(value) ? value : null
  const images = Array.isArray(value)
    ? value
    : Array.isArray(record?.images)
      ? record.images
      : null

  if (!images) {
    throw new Error('Failed to load gallery')
  }

  const total =
    typeof record?.total === 'number' && Number.isFinite(record.total)
      ? Math.max(0, Math.trunc(record.total))
      : images.length
  const has_more =
    typeof record?.has_more === 'boolean'
      ? record.has_more
      : total > images.length

  return {
    images: images as GeneratedImage[],
    total,
    has_more,
  }
}

const getEntityPayload = <T extends { id: string }>(
  value: unknown,
  property: string,
  message: string
): T => requireEntityResponse<T>(getNestedRecordPayload(value, property, message), message)

const normalizeSuggestedPromptsPayload = (value: unknown) => {
  const record = requireRecordResponse(value, 'Failed to suggest prompts')
  const prompts = requireArrayResponse<{ name: unknown; prompt_text: unknown }>(
    record.prompts,
    'Failed to suggest prompts'
  )

  return prompts.map((prompt) => {
    if (typeof prompt.name !== 'string' || typeof prompt.prompt_text !== 'string') {
      throw new Error('Failed to suggest prompts')
    }
    return {
      name: prompt.name,
      prompt_text: prompt.prompt_text,
    }
  })
}

const getUploadErrorMessage = (value: unknown) =>
  isRecord(value) ? extractErrorMessage(value.error) : null

const getResponseCount = (value: unknown, property: string) => {
  if (!isRecord(value)) return null
  const count = value[property]
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
  return Math.trunc(count)
}

const normalizeSignedUploadPayload = (value: unknown): Array<SignedReferenceUpload | FailedReferenceUpload> => {
  if (!Array.isArray(value)) {
    throw new Error('Failed to sign upload')
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      return { clientId: 'unknown', error: 'Failed to sign upload' }
    }

    const clientId = typeof item.clientId === 'string' && item.clientId.trim()
      ? item.clientId
      : 'unknown'
    const itemError = extractErrorMessage(item.error)
    if (itemError && !('signedUrl' in item)) {
      return { clientId, error: itemError }
    }

    const signedUrl = typeof item.signedUrl === 'string' ? item.signedUrl : ''
    const storagePath = typeof item.storage_path === 'string' ? item.storage_path : ''
    const fileName = typeof item.file_name === 'string' ? item.file_name : ''
    const mimeType = typeof item.mime_type === 'string' ? item.mime_type : ''
    const fileSize = typeof item.file_size === 'number' && Number.isFinite(item.file_size)
      ? item.file_size
      : 0
    const displayOrder = typeof item.display_order === 'number' && Number.isFinite(item.display_order)
      ? item.display_order
      : 0

    if (!signedUrl || !storagePath || !fileName || !mimeType) {
      return { clientId, error: 'Failed to sign upload' }
    }

    return {
      clientId,
      signedUrl,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
      file_size: fileSize,
      display_order: displayOrder,
    }
  })
}

const isRetryableNetworkError = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && error.name === 'TimeoutError')

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
    await wait(getRetryDelayMs(attempt, response))
  }

  return response as Response
}

const uploadToSignedUrl = (signedUrl: string, file: File) =>
  withRetry(
    () =>
      fetchWithTimeout(
        signedUrl,
        {
          method: 'PUT',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        },
        UPLOAD_REQUEST_TIMEOUT_MS
      ),
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
  if (error instanceof Error && error.name === 'AbortError') return
  logger.error(`[Store:${scope}] ${sanitizePublicErrorMessage(error)}`)
}

const getInFlightRequest = <T>(key: string, request: (signal: AbortSignal) => Promise<T>) => {
  const existingRequest = inFlightRequests.get(key)
  if (existingRequest) return existingRequest.promise as Promise<T>

  const controller = new AbortController()
  const nextRequest = request(controller.signal).finally(() => {
    if (inFlightRequests.get(key)?.promise === nextRequest) {
      inFlightRequests.delete(key)
    }
  })

  inFlightRequests.set(key, { controller, promise: nextRequest })
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
  loadingRefSets: false,
  loadingJobs: false,
  loadingGallery: false,
  loadingGalleryMore: false,
  settingsTemplates: [],
  loadingSettingsTemplates: false,
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

const mergeGalleryImagesPreservingLoadedUrls = (
  previousImages: GeneratedImage[],
  nextImages: GeneratedImage[]
) => {
  if (previousImages.length === 0 || nextImages.length === 0) return nextImages

  const previousById = new Map(previousImages.map((image) => [image.id, image]))

  return nextImages.map((image) => {
    const previous = previousById.get(image.id)
    if (!previous) return image

    return {
      ...image,
      public_url:
        previous.storage_path === image.storage_path && previous.public_url
          ? previous.public_url
          : image.public_url,
      thumb_public_url:
        previous.thumb_storage_path === image.thumb_storage_path && previous.thumb_public_url
          ? previous.thumb_public_url
          : image.thumb_public_url,
      preview_public_url:
        previous.preview_storage_path === image.preview_storage_path && previous.preview_public_url
          ? previous.preview_public_url
          : image.preview_public_url,
    }
  })
}

const getGalleryQueryString = (
  filters?: {
    job_id?: string
    approval_status?: string
    media_type?: string
    scene_id?: string
    sort?: string
  },
  offset = 0,
  limit = GALLERY_PAGE_SIZE
) => {
  const params = new URLSearchParams()
  if (filters?.job_id) params.set('job_id', filters.job_id.trim())
  if (filters?.approval_status) params.set('approval_status', filters.approval_status.trim())
  if (filters?.media_type) params.set('media_type', filters.media_type.trim())
  if (filters?.scene_id) params.set('scene_id', filters.scene_id.trim())
  if (filters?.sort) params.set('sort', filters.sort.trim())
  params.set('limit', String(clampInteger(limit, 1, 200, GALLERY_PAGE_SIZE)))
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
    reference_sets: Array<{
      reference_set_id: string
      role: 'subject' | 'texture'
      image_count: number | null
      subject_label: string | null
    }>
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

const api = async (
  url: string,
  options?: RequestInit,
  timeoutMs = API_REQUEST_TIMEOUT_MS
): Promise<unknown> => {
  const method = (options?.method ?? 'GET').toUpperCase()
  let res: Response

  try {
    res = await withRetry(
      () =>
        fetchWithTimeout(
          url,
          { ...options, cache: 'no-store', credentials: 'same-origin' },
          timeoutMs
        ),
      {
        retries: method === 'GET' ? MAX_API_RETRIES : 0,
        shouldRetryResponse: (response) => !response.ok && RETRYABLE_RESPONSE_STATUSES.has(response.status),
        shouldRetryError: isRetryableNetworkError,
      }
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
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

const getLocalStorage = () => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const getDevParallelDefault = () => {
  if (typeof window === 'undefined') return true
  try {
    const stored = getLocalStorage()?.getItem('devParallelGeneration')
    if (stored === null || stored === undefined) return true
    return stored === 'true'
  } catch (error) {
    logStoreError('DevParallelGenerationStorage', error)
    return true
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  devParallelGeneration: getDevParallelDefault(),
  setDevParallelGeneration: (enabled) => {
    set({ devParallelGeneration: enabled })
    try {
      getLocalStorage()?.setItem('devParallelGeneration', String(enabled))
    } catch (error) {
      logStoreError('DevParallelGenerationStorage', error)
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
      const data = requireArrayResponse<Project>(
        await getInFlightRequest(requestKey, (signal) => api('/api/projects', { signal })),
        'Failed to load projects'
      )
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
    const previousProjectId = getActiveSliceScope('currentProject')
    if (updateSliceScope('currentProject', projectId)) {
      if (previousProjectId) {
        const errorLogsRequestKey = activeSliceRequests.get('errorLogs')
        if (errorLogsRequestKey === buildRequestKey('errorLogs', previousProjectId)) {
          invalidateTrackedRequest(errorLogsRequestKey)
        }
      }
      const errorLogsScopeChanged = updateSliceScope('errorLogs', projectId)
      set({
        currentProject: null,
        errorLogs: [],
        ...(errorLogsScopeChanged ? { loadingErrorLogs: false } : {}),
      })
    }
    const requestKey = buildRequestKey('currentProject', projectId)
    const requestVersion = beginTrackedSliceRequest('currentProject', requestKey)
    try {
      const data = requireEntityResponse<Project>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/projects/${buildApiPath(projectId)}`, { signal })
        ),
        'Failed to load project'
      )
      if (!isLatestRequest(requestKey, requestVersion) || !isCurrentSliceScope('currentProject', projectId)) return
      markRequestSuccessful(requestKey)
      set({ currentProject: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('currentProject', projectId) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ currentProject: null })
      }
      logStoreError('Project', error)
    }
  },
  createProject: async (data) => {
    const project = requireEntityResponse<Project>(
      await api('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizeLabelInput(data.name),
          description: data.description ? trimTextInput(data.description) : undefined,
        }),
      }),
      'Failed to create project'
    )
    invalidateRequestKeys(buildRequestKey('projects'))
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },
  updateProject: async (id, data) => {
    const projectId = requireUuid(id, 'project id')
    const project = requireEntityResponse<Project>(
      await api(`/api/projects/${buildApiPath(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: data.name ? normalizeLabelInput(data.name) : data.name,
          description:
            typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
        }),
      }),
      'Failed to update project'
    )
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
    const requestVersion = beginTrackedSliceRequest('products', requestKey)
    set({ loadingProducts: true })
    try {
      const params = new URLSearchParams()
      if (scopedProjectId) params.set('project_id', scopedProjectId)
      const qs = params.toString()
      const data = requireArrayResponse<Product>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products${qs ? `?${qs}` : ''}`, { signal })
        ),
        'Failed to load products'
      )
      if (!isLatestRequest(requestKey, requestVersion) || !isCurrentSliceScope('products', scopeToken)) return
      markRequestSuccessful(requestKey)
      set({ products: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('products', scopeToken) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ products: [] })
      }
      logStoreError('Products', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('products', scopeToken)) {
        set({ loadingProducts: false })
      }
    }
  },
  fetchProduct: async (id) => {
    const productId = requireUuid(id, 'product id')
    const previousProductId = getActiveSliceScope('currentProduct')
    let cancelledSlices = new Set<string>()
    if (updateSliceScope('currentProduct', productId)) {
      if (previousProductId) cancelledSlices = cancelProductScopedRequests(previousProductId)
      // Switching products: clear the previous product's cached data so the
      // persistent layout (e.g. GlobalGenerationQueue) doesn't show stale data.
      // We do NOT reset the per-slice scopes here — each slice's own fetch keys
      // on the product id and clears/refetches itself on a product change.
      // Resetting them here would race with sibling page fetches (which run
      // first, child-before-parent) and silently discard their results,
      // leaving pages like the gallery blank. Loading flags are preserved so
      // an in-flight child fetch keeps its spinner instead of flashing empty.
      set({
        currentProduct: null,
        referenceSets: [],
        referenceImages: {},
        promptTemplates: [],
        generationJobs: [],
        currentJob: null,
        galleryImages: [],
        galleryTotal: 0,
        galleryHasMore: false,
        settingsTemplates: [],
        ...(cancelledSlices.has('referenceSets') ? { loadingRefSets: false } : {}),
        ...(cancelledSlices.has('generationJobs') ? { loadingJobs: false } : {}),
        ...(cancelledSlices.has('gallery')
          ? { loadingGallery: false, loadingGalleryMore: false }
          : {}),
        ...(cancelledSlices.has('settingsTemplates') ? { loadingSettingsTemplates: false } : {}),
      })
    }
    const requestKey = buildRequestKey('currentProduct', productId)
    const requestVersion = beginTrackedSliceRequest('currentProduct', requestKey)
    try {
      const data = requireEntityResponse<Product>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(productId)}`, { signal })
        ),
        'Failed to load product'
      )
      if (!isLatestRequest(requestKey, requestVersion) || !isCurrentSliceScope('currentProduct', productId)) return
      markRequestSuccessful(requestKey)
      set({ currentProduct: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('currentProduct', productId) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ currentProduct: null })
      }
      logStoreError('Product', error)
    }
  },
  createProduct: async (data) => {
    const projectId = requireUuid(data.project_id, 'project id')
    const product = requireEntityResponse<Product>(
      await api('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: normalizeLabelInput(data.name),
          description: data.description ? trimTextInput(data.description) : undefined,
          project_id: projectId,
        }),
      }),
      'Failed to create product'
    )
    invalidateRequestKeys(buildRequestKey('products', projectId))
    if (isCurrentOrUntrackedSliceScope('products', projectId)) {
      set((s) => ({ products: [product, ...s.products] }))
    }
    return product
  },
  updateProduct: async (id, data) => {
    const productId = requireUuid(id, 'product id')
    const nextProjectId = optionalUuid(data.project_id, 'project id')
    const existingProduct = get().products.find((product) => product.id === productId)
    const product = requireEntityResponse<Product>(
      await api(`/api/products/${buildApiPath(productId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: data.name ? normalizeLabelInput(data.name) : data.name,
          description:
            typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
          project_id: nextProjectId,
        }),
      }),
      'Failed to update product'
    )
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
    const deletedCurrentProduct = get().currentProduct?.id === productId
    if (deletedCurrentProduct) clearProductScopedSliceScopes()
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
    const requestVersion = beginTrackedSliceRequest('referenceSets', requestKey)
    set({ loadingRefSets: true })
    try {
      const data = requireArrayResponse<ReferenceSet>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets`, { signal })
        ),
        'Failed to load reference sets'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('referenceSets', scopedProductId) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      set({ referenceSets: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('referenceSets', scopedProductId) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ referenceSets: [] })
      }
      logStoreError('ReferenceSets', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('referenceSets', scopedProductId)) {
        set({ loadingRefSets: false })
      }
    }
  },
  createReferenceSet: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const refSet = requireEntityResponse<ReferenceSet>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: normalizeLabelInput(data.name),
          description: data.description ? trimTextInput(data.description) : undefined,
        }),
      }),
      'Failed to create reference set'
    )
    invalidateRequestKeys(buildRequestKey('referenceSets', scopedProductId))
    if (isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)) {
      set((s) => ({ referenceSets: [...s.referenceSets, refSet] }))
    }
    return refSet
  },
  updateReferenceSet: async (productId, setId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const refSet = requireEntityResponse<ReferenceSet>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: data.name ? normalizeLabelInput(data.name) : data.name,
          description:
            typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
        }),
      }),
      'Failed to update reference set'
    )
    invalidateRequestKeys(buildRequestKey('referenceSets', scopedProductId))
    if (isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)) {
      set((s) => ({
        referenceSets: s.referenceSets.map((r) =>
          r.id === referenceSetId ? refSet : data.is_active ? { ...r, is_active: false } : r
        ),
      }))
    }
  },
  deleteReferenceSet: async (productId, setId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}`, { method: 'DELETE' })
    invalidateRequestKeys(
      buildRequestKey('referenceSets', scopedProductId),
      buildRequestKey('referenceImages', scopedProductId, referenceSetId)
    )
    if (isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)) {
      set((s) => {
        const nextReferenceImages = { ...s.referenceImages }
        delete nextReferenceImages[referenceSetId]
        return {
          referenceSets: s.referenceSets.filter((r) => r.id !== referenceSetId),
          referenceImages: nextReferenceImages,
        }
      })
    }
  },

  // Reference Images
  referenceImages: {},
  fetchReferenceImages: async (productId, setId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const referenceSetId = requireUuid(setId, 'reference set id')
    const requestKey = buildRequestKey('referenceImages', scopedProductId, referenceSetId)
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = requireArrayResponse<ReferenceImage>(
        await getInFlightRequest(requestKey, (signal) =>
          api(
            `/api/products/${buildApiPath(scopedProductId)}/reference-sets/${buildApiPath(referenceSetId)}/images`,
            { signal }
          )
        ),
        'Failed to load reference images'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)
      )
        return
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

    const signedPayload = normalizeSignedUploadPayload(signed)

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
      if (!Array.isArray(data)) {
        throw new Error('Upload finalization failed')
      }
      payload = data as Array<ReferenceImage & { error?: string; file?: string }>
    }

    const uploaded = payload.filter((img) => Boolean(img?.id))
    const errors = [
      ...uploadResults.filter((u) => u.error),
      ...payload.filter((img) => !img?.id && img?.error),
    ]
    const firstError = getUploadErrorMessage(errors[0])
    if (uploaded.length > 0 && errors.length > 0) {
      logStoreError('ReferenceImageUpload', new Error(firstError || 'Some uploads failed'))
    }
    if (isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)) {
      set((s) => ({
        referenceImages: {
          ...s.referenceImages,
          [referenceSetId]: [...(s.referenceImages[referenceSetId] || []), ...uploaded],
        },
      }))
    }
    invalidateRequestKeys(referenceImagesRequestKey)
    if (uploaded.length === 0 && errors.length > 0) {
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
    if (isCurrentProductScopedSlice('referenceSets', scopedProductId, scopedProductId)) {
      set((s) => ({
        referenceImages: {
          ...s.referenceImages,
          [referenceSetId]: (s.referenceImages[referenceSetId] || []).filter((i) => i.id !== imageId),
        },
      }))
    }
  },

  // Prompt Templates
  promptTemplates: [],
  fetchPromptTemplates: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    if (updateSliceScope('promptTemplates', scopedProductId)) {
      set({ promptTemplates: [] })
    }
    const requestKey = buildRequestKey('promptTemplates', scopedProductId)
    const requestVersion = beginTrackedSliceRequest('promptTemplates', requestKey)
    try {
      const data = requireArrayResponse<PromptTemplate>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(scopedProductId)}/prompts`, { signal })
        ),
        'Failed to load prompt templates'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('promptTemplates', scopedProductId) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      set({ promptTemplates: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('promptTemplates', scopedProductId) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ promptTemplates: [] })
      }
      logStoreError('PromptTemplates', error)
    }
  },
  createPromptTemplate: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const tmpl = requireEntityResponse<PromptTemplate>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: normalizeLabelInput(data.name),
          prompt_text: sanitizePromptText(data.prompt_text, 'prompt_text'),
          tags: data.tags ? sanitizeStringArray(data.tags) : undefined,
        }),
      }),
      'Failed to create prompt template'
    )
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    if (isCurrentProductScopedSlice('promptTemplates', scopedProductId, scopedProductId)) {
      set((s) => ({ promptTemplates: [...s.promptTemplates, tmpl] }))
    }
    return tmpl
  },
  updatePromptTemplate: async (productId, promptId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const promptTemplateId = requireUuid(promptId, 'prompt template id')
    const tmpl = requireEntityResponse<PromptTemplate>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/prompts/${buildApiPath(promptTemplateId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: data.name ? normalizeLabelInput(data.name) : data.name,
          prompt_text:
            typeof data.prompt_text === 'string' ? sanitizePromptText(data.prompt_text, 'prompt_text') : data.prompt_text,
          tags: data.tags ? sanitizeStringArray(data.tags) : data.tags,
        }),
      }),
      'Failed to update prompt template'
    )
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    if (isCurrentProductScopedSlice('promptTemplates', scopedProductId, scopedProductId)) {
      set((s) => ({ promptTemplates: s.promptTemplates.map((p) => (p.id === promptTemplateId ? tmpl : p)) }))
    }
  },
  deletePromptTemplate: async (productId, promptId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const promptTemplateId = requireUuid(promptId, 'prompt template id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/prompts/${buildApiPath(promptTemplateId)}`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('promptTemplates', scopedProductId))
    if (isCurrentProductScopedSlice('promptTemplates', scopedProductId, scopedProductId)) {
      set((s) => ({ promptTemplates: s.promptTemplates.filter((p) => p.id !== promptTemplateId) }))
    }
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
    const requestVersion = beginTrackedSliceRequest('generationJobs', requestKey)
    const shouldShowLoading = get().generationJobs.length === 0
    if (shouldShowLoading) set({ loadingJobs: true })
    try {
      const data = requireArrayResponse<GenerationJob>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(scopedProductId)}/generate`, { signal })
        ),
        'Failed to load generation jobs'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('generationJobs', requestKey) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      set({ generationJobs: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('generationJobs', requestKey) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ generationJobs: [] })
      }
      logStoreError('GenerationJobs', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('generationJobs', requestKey)) {
        set({ loadingJobs: false })
      }
    }
  },
  startGeneration: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const devParallel = get().devParallelGeneration
    const sanitizedRefSets = (data.reference_sets || []).map((rs) => ({
      reference_set_id: requireUuid(rs.reference_set_id, 'reference set id'),
      role: rs.role,
      image_count: rs.image_count != null ? clampInteger(rs.image_count, 1, 14, 1) : null,
      subject_label: rs.subject_label && rs.subject_label.trim() ? rs.subject_label.trim().slice(0, 80) : null,
    }))
    const body = {
      ...data,
      prompt_text: sanitizePromptText(data.prompt_text, 'prompt_text'),
      prompt_template_id: optionalUuid(data.prompt_template_id, 'prompt template id') ?? null,
      reference_sets: sanitizedRefSets,
      source_image_id: optionalUuid(data.source_image_id, 'source image id') ?? null,
      variation_count: clampInteger(data.variation_count ?? 15, 1, 100, 15),
      ...(isClientDevelopmentRuntime() && !devParallel
        ? { parallelism_override: 1, batch_override: 1 }
        : {}),
    }
    const job = getEntityPayload<GenerationJob>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      'job',
      'Failed to start generation'
    )
    const generationJobsRequestKey = buildRequestKey('generationJobs', scopedProductId)
    invalidateRequestKeys(generationJobsRequestKey)
    if (isCurrentProductScopedSlice('generationJobs', generationJobsRequestKey, scopedProductId)) {
      set((s) => ({ generationJobs: [job, ...s.generationJobs] }))
    }
    return job
  },
  fetchJobStatus: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    const requestKey = buildRequestKey('currentJob', scopedProductId, generationJobId)
    if (updateSliceScope('currentJob', requestKey)) {
      set({ currentJob: null })
    }
    const requestVersion = beginTrackedSliceRequest('currentJob', requestKey)
    try {
      const data = requireRecordResponse(
        await getInFlightRequest(requestKey, (signal) =>
          api(
            `/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}`,
            { signal }
          )
        ),
        'Failed to load job status'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('currentJob', requestKey) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      const job = requireEntityResponse<GenerationJob>(data.job, 'Failed to load job status')
      const images = data.images === undefined
        ? undefined
        : requireArrayResponse<GeneratedImage>(data.images, 'Failed to load job images')
      set({ currentJob: { ...job, images } })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('currentJob', requestKey) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ currentJob: null })
      }
      logStoreError('CurrentJob', error)
    }
  },
  retryGenerationJob: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    const job = getEntityPayload<GenerationJob>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}/retry`, {
        method: 'POST',
      }),
      'job',
      'Failed to retry generation job'
    )
    invalidateRequestKeys(
      buildRequestKey('generationJobs', scopedProductId),
      buildRequestKey('currentJob', scopedProductId, generationJobId)
    )
    if (
      isCurrentProductScopedSlice(
        'generationJobs',
        buildRequestKey('generationJobs', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({
        generationJobs: [job, ...s.generationJobs.filter((j) => j.id !== job.id)],
        currentJob: s.currentJob?.id === job.id ? { ...job, images: s.currentJob?.images } : s.currentJob,
      }))
    }
    return job
  },
  clearGenerationQueue: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const result = await api(`/api/products/${buildApiPath(scopedProductId)}/generate`, {
      method: 'DELETE',
    })
    const generationJobsRequestKey = buildRequestKey('generationJobs', scopedProductId)
    invalidateRequestKeys(generationJobsRequestKey)
    if (isCurrentProductScopedSlice('generationJobs', generationJobsRequestKey, scopedProductId)) {
      const jobs = get().generationJobs
      const activeJobs = jobs.filter((job) => job.status === 'pending' || job.status === 'running')
      if (getResponseCount(result, 'cancelled') === activeJobs.length) {
        const completedAt = new Date().toISOString()
        set({
          generationJobs: jobs.map((job) =>
            job.status === 'pending' || job.status === 'running'
              ? {
                  ...job,
                  status: 'cancelled',
                  error_message: 'Cancelled by user',
                  completed_at: completedAt,
                }
              : job
          ),
        })
      } else {
        await get().fetchGenerationJobs(scopedProductId)
      }
    }
  },
  clearGenerationFailures: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const result = await api(
      `/api/products/${buildApiPath(scopedProductId)}/generate?scope=failed`,
      { method: 'DELETE' }
    )
    const generationJobsRequestKey = buildRequestKey('generationJobs', scopedProductId)
    invalidateRequestKeys(generationJobsRequestKey)
    if (isCurrentProductScopedSlice('generationJobs', generationJobsRequestKey, scopedProductId)) {
      const jobs = get().generationJobs
      const failedJobs = jobs.filter((job) => job.status === 'failed')
      if (getResponseCount(result, 'cleared_failed') === failedJobs.length) {
        set({ generationJobs: jobs.filter((job) => job.status !== 'failed') })
      } else {
        await get().fetchGenerationJobs(scopedProductId)
      }
    }
  },
  deleteGenerationJob: async (productId, jobId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const generationJobId = requireUuid(jobId, 'generation job id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate/${buildApiPath(generationJobId)}`, { method: 'DELETE' })
    invalidateRequestKeys(
      buildRequestKey('generationJobs', scopedProductId),
      buildRequestKey('currentJob', scopedProductId, generationJobId)
    )
    if (
      isCurrentProductScopedSlice(
        'generationJobs',
        buildRequestKey('generationJobs', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({
        generationJobs: s.generationJobs.filter((j) => j.id !== generationJobId),
        currentJob: s.currentJob?.id === generationJobId ? null : s.currentJob,
      }))
    }
  },
  clearGenerationLog: async (productId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    await api(`/api/products/${buildApiPath(scopedProductId)}/generate?scope=log`, { method: 'DELETE' })
    const generationJobsRequestKey = buildRequestKey('generationJobs', scopedProductId)
    invalidateRequestKeys(generationJobsRequestKey, getActiveProductRequestScope('currentJob', scopedProductId))
    if (isCurrentProductScopedSlice('generationJobs', generationJobsRequestKey, scopedProductId)) {
      set((s) => ({
        generationJobs: s.generationJobs.filter((j) => j.status === 'pending' || j.status === 'running'),
        currentJob:
          s.currentJob && (s.currentJob.status === 'completed' || s.currentJob.status === 'failed')
            ? null
            : s.currentJob,
      }))
    }
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
    if (updateSliceScope('gallery', requestKey)) {
      set({ galleryImages: [], galleryTotal: 0, galleryHasMore: false, loadingGallery: false, loadingGalleryMore: false })
    }
    const requestVersion = beginTrackedSliceRequest('gallery', requestKey)
    const loadedCount = get().galleryImages.length
    const shouldShowLoading = loadedCount === 0
    const qs = getGalleryQueryString(sanitizedFilters, 0, Math.max(GALLERY_PAGE_SIZE, loadedCount))
    if (shouldShowLoading) set({ loadingGallery: true })
    try {
      const data = normalizeGalleryPayload(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(scopedProductId)}/gallery?${qs}`, { signal })
        )
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('gallery', requestKey) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      set((state) => ({
        galleryImages: mergeGalleryImagesPreservingLoadedUrls(state.galleryImages, data.images),
        galleryTotal: data.total,
        galleryHasMore: data.has_more,
      }))
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('gallery', requestKey) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ galleryImages: [], galleryTotal: 0, galleryHasMore: false })
      }
      logStoreError('Gallery', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('gallery', requestKey)) {
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
      const data = normalizeGalleryPayload(await api(`/api/products/${buildApiPath(scopedProductId)}/gallery?${qs}`))
      if (
        !isCurrentSliceScope('gallery', requestKey) ||
        !isLatestRequest(requestKey, requestVersion) ||
        !isActiveProductScope(scopedProductId)
      ) {
        return
      }
      const newImages = data.images
      set((state) => {
        const existingIds = new Set(state.galleryImages.map((img) => img.id))
        const unique = newImages.filter((img: GeneratedImage) => !existingIds.has(img.id))
        return {
          galleryImages: [...state.galleryImages, ...unique],
          galleryTotal: data.total,
          galleryHasMore: data.has_more,
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
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    const updated = getNestedRecordPayload<Record<string, unknown>>(
      await api(`/api/images/${buildApiPath(scopedImageId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_status: sanitizeApprovalStatus(approval_status, { allowNull: true }) ?? null,
          notes: typeof notes === 'string' ? trimTextInput(notes) : notes,
        }),
      }),
      'image',
      'Failed to update image'
    ) as Partial<GeneratedImage>
    invalidateRequestKeys(activeGalleryScope, activeCurrentJobScope)
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
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    await api(`/api/images/${buildApiPath(scopedImageId)}`, { method: 'DELETE' })
    const idSet = new Set([scopedImageId])
    invalidateRequestKeys(activeGalleryScope, activeCurrentJobScope)
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
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    await api('/api/images/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds: sanitizedIds }),
    })
    const idSet = new Set(sanitizedIds)
    invalidateRequestKeys(activeGalleryScope, activeCurrentJobScope)
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
    const requestVersion = beginTrackedSliceRequest('settingsTemplates', requestKey)
    set({ loadingSettingsTemplates: true })
    try {
      const data = requireArrayResponse<SettingsTemplate>(
        await getInFlightRequest(requestKey, (signal) =>
          api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates`, { signal })
        ),
        'Failed to load settings templates'
      )
      if (
        !isLatestRequest(requestKey, requestVersion) ||
        !isCurrentSliceScope('settingsTemplates', requestKey) ||
        !isActiveProductScope(scopedProductId)
      )
        return
      markRequestSuccessful(requestKey)
      set({ settingsTemplates: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('settingsTemplates', requestKey) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ settingsTemplates: [] })
      }
      logStoreError('SettingsTemplates', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('settingsTemplates', requestKey)) {
        set({ loadingSettingsTemplates: false })
      }
    }
  },
  createSettingsTemplate: async (productId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const tmpl = requireEntityResponse<SettingsTemplate>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          name: normalizeLabelInput(data.name),
        }),
      }),
      'Failed to create settings template'
    )
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    if (
      isCurrentProductScopedSlice(
        'settingsTemplates',
        buildRequestKey('settingsTemplates', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({ settingsTemplates: [...s.settingsTemplates, tmpl] }))
    }
    return tmpl
  },
  updateSettingsTemplate: async (productId, templateId, data) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    const requestBody = {
      ...data,
      name: data.name ? normalizeLabelInput(data.name) : data.name,
    }
    const tmpl = requireEntityResponse<SettingsTemplate>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      'Failed to update settings template'
    )
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    if (
      isCurrentProductScopedSlice(
        'settingsTemplates',
        buildRequestKey('settingsTemplates', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({
        settingsTemplates: s.settingsTemplates.map((t) =>
          t.id === settingsTemplateId ? tmpl : data.is_active ? { ...t, is_active: false } : t
        ),
      }))
    }
  },
  deleteSettingsTemplate: async (productId, templateId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    await api(
      `/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`,
      { method: 'DELETE' }
    )
    invalidateRequestKeys(buildRequestKey('settingsTemplates', scopedProductId))
    if (
      isCurrentProductScopedSlice(
        'settingsTemplates',
        buildRequestKey('settingsTemplates', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({ settingsTemplates: s.settingsTemplates.filter((t) => t.id !== settingsTemplateId) }))
    }
  },
  activateSettingsTemplate: async (productId, templateId) => {
    const scopedProductId = requireUuid(productId, 'product id')
    const settingsTemplateId = requireUuid(templateId, 'settings template id')
    const currentProductRequestKey = buildRequestKey('currentProduct', scopedProductId)
    const tmpl = requireEntityResponse<SettingsTemplate>(
      await api(`/api/products/${buildApiPath(scopedProductId)}/settings-templates/${buildApiPath(settingsTemplateId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      }),
      'Failed to activate settings template'
    )
    const canApplyProductSettings = get().currentProduct?.id === scopedProductId
    invalidateRequestKeys(
      buildRequestKey('settingsTemplates', scopedProductId),
      currentProductRequestKey
    )
    if (
      isCurrentProductScopedSlice(
        'settingsTemplates',
        buildRequestKey('settingsTemplates', scopedProductId),
        scopedProductId
      )
    ) {
      set((s) => ({
        settingsTemplates: s.settingsTemplates.map((t) =>
          t.id === settingsTemplateId ? tmpl : { ...t, is_active: false }
        ),
        currentProduct:
          s.currentProduct?.id === scopedProductId
            ? { ...s.currentProduct, global_style_settings: tmpl.settings }
            : s.currentProduct,
      }))
    }
    if (!canApplyProductSettings && isCurrentSliceScope('currentProduct', scopedProductId)) {
      await get().fetchProduct(scopedProductId)
    }
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
    const requestVersion = beginTrackedSliceRequest('errorLogs', requestKey)
    set({ loadingErrorLogs: true })
    try {
      const qs = buildProjectScopedQuery(scopedProjectId)
      const data = requireArrayResponse<ErrorLog>(
        await getInFlightRequest(requestKey, (signal) => api(`/api/error-logs?${qs}`, { signal })),
        'Failed to load error logs'
      )
      if (!isLatestRequest(requestKey, requestVersion) || !isCurrentSliceScope('errorLogs', scopedProjectId)) return
      markRequestSuccessful(requestKey)
      set({ errorLogs: data })
    } catch (error) {
      if (
        isLatestRequest(requestKey, requestVersion) &&
        isCurrentSliceScope('errorLogs', scopedProjectId) &&
        !shouldPreserveStateOnFetchError(requestKey)
      ) {
        set({ errorLogs: [] })
      }
      logStoreError('ErrorLogs', error)
    } finally {
      if (isLatestRequest(requestKey, requestVersion) && isCurrentSliceScope('errorLogs', scopedProjectId)) {
        set({ loadingErrorLogs: false })
      }
    }
  },
  clearErrorLogs: async (projectId) => {
    const scopedProjectId = requireUuid(projectId, 'project id')
    const qs = buildProjectScopedQuery(scopedProjectId)
    await api(`/api/error-logs?${qs}`, { method: 'DELETE' })
    invalidateRequestKeys(buildRequestKey('errorLogs', scopedProjectId))
    if (isCurrentOrUntrackedSliceScope('errorLogs', scopedProjectId)) {
      set({ errorLogs: [] })
    }
  },

  // AI
  aiLoading: false,
  buildPrompt: async (productId, userPrompt) => {
    beginAiRequest(set)
    try {
      const data = requireRecordResponse(
        await api(
          '/api/ai/build-prompt',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_id: requireUuid(productId, 'product id'),
              user_prompt: sanitizePromptText(userPrompt, 'user_prompt'),
            }),
          },
          AI_REQUEST_TIMEOUT_MS
        ),
        'Failed to build prompt'
      )
      if (typeof data.refined_prompt !== 'string') {
        throw new Error('Failed to build prompt')
      }
      return data.refined_prompt
    } finally {
      endAiRequest(set)
    }
  },
  suggestPrompts: async (productId, count = 5) => {
    beginAiRequest(set)
    try {
      return normalizeSuggestedPromptsPayload(
        await api(
          '/api/ai/suggest-prompts',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_id: requireUuid(productId, 'product id'),
              count: clampInteger(count, 1, MAX_SUGGESTED_PROMPT_COUNT, 5),
            }),
          },
          AI_REQUEST_TIMEOUT_MS
        )
      )
    } finally {
      endAiRequest(set)
    }
  },
}))
