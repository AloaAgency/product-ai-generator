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

const DEFAULT_ERROR_MESSAGE = 'Request failed'
const MAX_ERROR_MESSAGE_LENGTH = 200
const MAX_SUGGESTED_PROMPT_COUNT = 10
const requestVersions = new Map<string, number>()
const sliceScopes = new Map<string, string>()
let aiRequestCount = 0

const sanitizePathSegment = (value: string) => encodeURIComponent(value.trim())

const buildApiPath = (...segments: string[]) =>
  segments.map((segment) => sanitizePathSegment(segment)).join('/')

const normalizeLabelInput = (value: string) => value.trim().replace(/\s+/g, ' ')
const trimTextInput = (value: string) => value.trim()
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
}

const isLatestRequest = (key: string, version: number) =>
  (requestVersions.get(key) ?? 0) === version

const updateSliceScope = (slice: string, scope: string) => {
  const normalizedScope = scope.trim() || '_'
  const previousScope = sliceScopes.get(slice)
  sliceScopes.set(slice, normalizedScope)
  return previousScope !== normalizedScope
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
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

const safeParseResponse = async (res: Response) => {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return res.json().catch(() => null)
  }

  const text = await res.text().catch(() => '')
  return text ? { error: text } : null
}

const logStoreError = (scope: string, error: unknown) => {
  console.error(`[Store:${scope}]`, error)
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
  loadingGallery: boolean
  fetchGallery: (productId: string, filters?: { job_id?: string; approval_status?: string; media_type?: string; scene_id?: string }) => Promise<void>
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
  const res = await fetch(url, options)
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
    const requestKey = 'projects'
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingProjects: true })
    try {
      const data = await api('/api/projects')
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ projects: data })
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingProjects: false })
      }
    }
  },
  fetchProject: async (id) => {
    const requestKey = 'currentProject'
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await api(`/api/projects/${buildApiPath(id)}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ currentProject: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ currentProject: null })
      }
      throw error
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
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },
  updateProject: async (id, data) => {
    const project = await api(`/api/projects/${buildApiPath(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
      }),
    })
    set((s) => ({
      currentProject: s.currentProject?.id === id ? project : s.currentProject,
      projects: s.projects.map((p) => (p.id === id ? project : p)),
    }))
  },
  deleteProject: async (id) => {
    await api(`/api/projects/${buildApiPath(id)}`, { method: 'DELETE' })
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      currentProject: s.currentProject?.id === id ? null : s.currentProject,
    }))
  },

  // Products
  products: [],
  currentProduct: null,
  loadingProducts: false,
  fetchProducts: async (projectId) => {
    const requestKey = 'products'
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingProducts: true })
    try {
      const params = new URLSearchParams()
      if (projectId) params.set('project_id', projectId.trim())
      const qs = params.toString()
      const data = await api(`/api/products${qs ? `?${qs}` : ''}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ products: data })
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingProducts: false })
      }
    }
  },
  fetchProduct: async (id) => {
    const requestKey = 'currentProduct'
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await api(`/api/products/${buildApiPath(id)}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ currentProduct: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ currentProduct: null })
      }
      throw error
    }
  },
  createProduct: async (data) => {
    const product = await api('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        description: data.description ? trimTextInput(data.description) : undefined,
        project_id: data.project_id.trim(),
      }),
    })
    set((s) => ({ products: [product, ...s.products] }))
    return product
  },
  updateProduct: async (id, data) => {
    const product = await api(`/api/products/${buildApiPath(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
        project_id: data.project_id?.trim(),
      }),
    })
    set((s) => ({
      currentProduct: s.currentProduct?.id === id ? product : s.currentProduct,
      products: s.products.map((p) => (p.id === id ? product : p)),
    }))
  },
  deleteProduct: async (id) => {
    await api(`/api/products/${buildApiPath(id)}`, { method: 'DELETE' })
    set((s) => ({
      products: s.products.filter((p) => p.id !== id),
      currentProduct: s.currentProduct?.id === id ? null : s.currentProduct,
      referenceSets: s.currentProduct?.id === id ? [] : s.referenceSets,
      referenceImages: s.currentProduct?.id === id ? {} : s.referenceImages,
      promptTemplates: s.currentProduct?.id === id ? [] : s.promptTemplates,
      generationJobs: s.currentProduct?.id === id ? [] : s.generationJobs,
      currentJob: s.currentProduct?.id === id ? null : s.currentJob,
      galleryImages: s.currentProduct?.id === id ? [] : s.galleryImages,
      settingsTemplates: s.currentProduct?.id === id ? [] : s.settingsTemplates,
    }))
  },

  // Reference Sets
  referenceSets: [],
  loadingRefSets: false,
  fetchReferenceSets: async (productId) => {
    const requestKey = 'referenceSets'
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingRefSets: true })
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/reference-sets`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ referenceSets: data })
    } finally {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ loadingRefSets: false })
      }
    }
  },
  createReferenceSet: async (productId, data) => {
    const refSet = await api(`/api/products/${buildApiPath(productId)}/reference-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        description: data.description ? trimTextInput(data.description) : undefined,
      }),
    })
    set((s) => ({ referenceSets: [...s.referenceSets, refSet] }))
    return refSet
  },
  updateReferenceSet: async (productId, setId, data) => {
    const refSet = await api(`/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        description:
          typeof data.description === 'string' ? trimTextInput(data.description) : data.description,
      }),
    })
    set((s) => ({
      referenceSets: s.referenceSets.map((r) =>
        r.id === setId ? refSet : data.is_active ? { ...r, is_active: false } : r
      ),
    }))
  },
  deleteReferenceSet: async (productId, setId) => {
    await api(`/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}`, { method: 'DELETE' })
    set((s) => {
      const nextReferenceImages = { ...s.referenceImages }
      delete nextReferenceImages[setId]
      return {
        referenceSets: s.referenceSets.filter((r) => r.id !== setId),
        referenceImages: nextReferenceImages,
      }
    })
  },

  // Reference Images
  referenceImages: {},
  fetchReferenceImages: async (productId, setId) => {
    const requestKey = `referenceImages:${productId}:${setId}`
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await api(
        `/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}/images`
      )
      if (!isLatestRequest(requestKey, requestVersion)) return
      set((s) => ({ referenceImages: { ...s.referenceImages, [setId]: data } }))
    } catch (error) {
      logStoreError('ReferenceImages', error)
    }
  },
  uploadReferenceImages: async (productId, setId, files) => {
    const uploadSpecs = files.map((file, index) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      clientId: `${index}-${Date.now()}`,
    }))

    const signed = await api(
      `/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}/images/upload-urls`,
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

    const fileMap = new Map(uploadSpecs.map((spec, idx) => [spec.clientId, files[idx]]))
    const uploadResults: Array<{
      storage_path: string
      file_name: string
      mime_type: string
      file_size: number
      display_order: number
      clientId: string
      error?: string
    }> = []

    for (const item of signedPayload) {
      if (!('signedUrl' in item)) {
        uploadResults.push({
          clientId: item.clientId,
          storage_path: '',
          file_name: '',
          mime_type: '',
          file_size: 0,
          display_order: 0,
          error: item.error || 'Failed to sign upload',
        })
        continue
      }

      const file = fileMap.get(item.clientId)
      if (!file) {
        uploadResults.push({
          clientId: item.clientId,
          storage_path: '',
          file_name: item.file_name,
          mime_type: item.mime_type,
          file_size: item.file_size,
          display_order: item.display_order,
          error: 'Missing file data',
        })
        continue
      }

      const uploadResp = await fetch(item.signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      })

      if (!uploadResp.ok) {
        uploadResults.push({
          clientId: item.clientId,
          storage_path: item.storage_path,
          file_name: item.file_name,
          mime_type: item.mime_type,
          file_size: item.file_size,
          display_order: item.display_order,
          error: `Upload failed (${uploadResp.status})`,
        })
        continue
      }

      uploadResults.push({
        clientId: item.clientId,
        storage_path: item.storage_path,
        file_name: item.file_name,
        mime_type: item.mime_type,
        file_size: item.file_size,
        display_order: item.display_order,
      })
    }

    const successfulUploads = uploadResults.filter((u) => !u.error)
    let payload: Array<ReferenceImage & { error?: string; file?: string }> = []
    if (successfulUploads.length > 0) {
      const data = await api(`/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}/images`, {
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
    if (uploaded.length === 0 && errors.length > 0) {
      const firstError =
        errors[0] && typeof errors[0] === 'object' && 'error' in errors[0]
          ? (errors[0] as { error?: string }).error
          : null
      throw new Error(firstError || 'Upload failed')
    }
  },
  deleteReferenceImage: async (productId, setId, imgId) => {
    await api(
      `/api/products/${buildApiPath(productId)}/reference-sets/${buildApiPath(setId)}/images/${buildApiPath(imgId)}`,
      { method: 'DELETE' }
    )
    set((s) => ({
      referenceImages: {
        ...s.referenceImages,
        [setId]: (s.referenceImages[setId] || []).filter((i) => i.id !== imgId),
      },
    }))
  },

  // Prompt Templates
  promptTemplates: [],
  fetchPromptTemplates: async (productId) => {
    const requestKey = 'promptTemplates'
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/prompts`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ promptTemplates: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ promptTemplates: [] })
      }
      throw error
    }
  },
  createPromptTemplate: async (productId, data) => {
    const tmpl = await api(`/api/products/${buildApiPath(productId)}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
        prompt_text: trimTextInput(data.prompt_text),
        tags: data.tags ? sanitizeStringArray(data.tags) : undefined,
      }),
    })
    set((s) => ({ promptTemplates: [...s.promptTemplates, tmpl] }))
    return tmpl
  },
  updatePromptTemplate: async (productId, promptId, data) => {
    const tmpl = await api(`/api/products/${buildApiPath(productId)}/prompts/${buildApiPath(promptId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: data.name ? normalizeLabelInput(data.name) : data.name,
        prompt_text:
          typeof data.prompt_text === 'string' ? trimTextInput(data.prompt_text) : data.prompt_text,
        tags: data.tags ? sanitizeStringArray(data.tags) : data.tags,
      }),
    })
    set((s) => ({ promptTemplates: s.promptTemplates.map((p) => (p.id === promptId ? tmpl : p)) }))
  },
  deletePromptTemplate: async (productId, promptId) => {
    await api(`/api/products/${buildApiPath(productId)}/prompts/${buildApiPath(promptId)}`, { method: 'DELETE' })
    set((s) => ({ promptTemplates: s.promptTemplates.filter((p) => p.id !== promptId) }))
  },

  // Generation
  generationJobs: [],
  currentJob: null,
  loadingJobs: false,
  fetchGenerationJobs: async (productId) => {
    const requestKey = `generationJobs:${productId.trim()}`
    if (updateSliceScope('generationJobs', requestKey)) {
      set({ generationJobs: [], currentJob: null, loadingJobs: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    const shouldShowLoading = get().generationJobs.length === 0
    if (shouldShowLoading) set({ loadingJobs: true })
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/generate`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ generationJobs: data })
    } catch (error) {
      logStoreError('GenerationJobs', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion)) {
        set({ loadingJobs: false })
      }
    }
  },
  startGeneration: async (productId, data) => {
    const devParallel = get().devParallelGeneration
    const body = {
      ...data,
      ...(process.env.NODE_ENV === 'development' && !devParallel
        ? { parallelism_override: 1, batch_override: 1 }
        : {}),
    }
    const result = await api(`/api/products/${buildApiPath(productId)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const job = result.job ?? result
    const activeGenerationJobsScope = getActiveSliceScope('generationJobs')
    if (activeGenerationJobsScope) invalidateTrackedRequest(activeGenerationJobsScope)
    set((s) => ({ generationJobs: [job, ...s.generationJobs] }))
    return job
  },
  fetchJobStatus: async (productId, jobId) => {
    const requestKey = `currentJob:${productId.trim()}:${jobId.trim()}`
    if (updateSliceScope('currentJob', requestKey)) {
      set({ currentJob: null })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/generate/${buildApiPath(jobId)}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ currentJob: { ...data.job, images: data.images } })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ currentJob: null })
      }
      logStoreError('CurrentJob', error)
    }
  },
  retryGenerationJob: async (productId, jobId) => {
    const data = await api(`/api/products/${buildApiPath(productId)}/generate/${buildApiPath(jobId)}/retry`, {
      method: 'POST',
    })
    const job = data.job ?? data
    const activeGenerationJobsScope = getActiveSliceScope('generationJobs')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGenerationJobsScope) invalidateTrackedRequest(activeGenerationJobsScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      generationJobs: [job, ...s.generationJobs.filter((j) => j.id !== job.id)],
      currentJob: s.currentJob?.id === job.id ? { ...job, images: s.currentJob?.images } : s.currentJob,
    }))
    return job
  },
  clearGenerationQueue: async (productId) => {
    await api(`/api/products/${buildApiPath(productId)}/generate`, { method: 'DELETE' })
    await get().fetchGenerationJobs(productId)
  },
  clearGenerationFailures: async (productId) => {
    await api(`/api/products/${buildApiPath(productId)}/generate?scope=failed`, { method: 'DELETE' })
    await get().fetchGenerationJobs(productId)
  },
  deleteGenerationJob: async (productId, jobId) => {
    await api(`/api/products/${buildApiPath(productId)}/generate/${buildApiPath(jobId)}`, { method: 'DELETE' })
    const activeGenerationJobsScope = getActiveSliceScope('generationJobs')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGenerationJobsScope) invalidateTrackedRequest(activeGenerationJobsScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      generationJobs: s.generationJobs.filter((j) => j.id !== jobId),
      currentJob: s.currentJob?.id === jobId ? null : s.currentJob,
    }))
  },
  clearGenerationLog: async (productId) => {
    await api(`/api/products/${buildApiPath(productId)}/generate?scope=log`, { method: 'DELETE' })
    const activeGenerationJobsScope = getActiveSliceScope('generationJobs')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGenerationJobsScope) invalidateTrackedRequest(activeGenerationJobsScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
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
  loadingGallery: false,
  fetchGallery: async (productId, filters) => {
    const qs = getGalleryQueryString(filters)
    const requestKey = `gallery:${productId.trim()}:${qs || '_'}`
    if (updateSliceScope('gallery', requestKey)) {
      set({ galleryImages: [], loadingGallery: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    const shouldShowLoading = get().galleryImages.length === 0
    if (shouldShowLoading) set({ loadingGallery: true })
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/gallery${qs ? `?${qs}` : ''}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ galleryImages: data.images ?? data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
        set({ galleryImages: [] })
      }
      logStoreError('Gallery', error)
    } finally {
      if (shouldShowLoading && isLatestRequest(requestKey, requestVersion)) {
        set({ loadingGallery: false })
      }
    }
  },
  updateImageApproval: async (imageId, approval_status, notes) => {
    const data = await api(`/api/images/${buildApiPath(imageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approval_status: approval_status?.trim() || null,
        notes: typeof notes === 'string' ? trimTextInput(notes) : notes,
      }),
    })
    const updated = data.image ?? data
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGalleryScope) invalidateTrackedRequest(activeGalleryScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      galleryImages: s.galleryImages.map((i) =>
        i.id === imageId ? { ...i, ...updated } : i
      ),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: s.currentJob.images.map((img) =>
              img.id === imageId ? { ...img, ...updated } : img
            ),
          }
        : s.currentJob,
    }))
  },
  deleteImage: async (imageId) => {
    await api(`/api/images/${buildApiPath(imageId)}`, { method: 'DELETE' })
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGalleryScope) invalidateTrackedRequest(activeGalleryScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      galleryImages: s.galleryImages.filter((i) => i.id !== imageId),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: s.currentJob.images.filter((img) => img.id !== imageId),
          }
        : s.currentJob,
    }))
  },
  bulkDeleteImages: async (imageIds) => {
    const sanitizedIds = sanitizeStringArray(imageIds)
    if (sanitizedIds.length === 0) return
    await api('/api/images/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds: sanitizedIds }),
    })
    const idSet = new Set(sanitizedIds)
    const activeGalleryScope = getActiveSliceScope('gallery')
    const activeCurrentJobScope = getActiveSliceScope('currentJob')
    if (activeGalleryScope) invalidateTrackedRequest(activeGalleryScope)
    if (activeCurrentJobScope) invalidateTrackedRequest(activeCurrentJobScope)
    set((s) => ({
      galleryImages: s.galleryImages.filter((i) => !idSet.has(i.id)),
      currentJob: s.currentJob?.images
        ? {
            ...s.currentJob,
            images: s.currentJob.images.filter((img) => !idSet.has(img.id)),
          }
        : s.currentJob,
    }))
  },

  // Settings Templates
  settingsTemplates: [],
  loadingSettingsTemplates: false,
  fetchSettingsTemplates: async (productId) => {
    const requestKey = `settingsTemplates:${productId.trim()}`
    if (updateSliceScope('settingsTemplates', requestKey)) {
      set({ settingsTemplates: [], loadingSettingsTemplates: false })
    }
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingSettingsTemplates: true })
    try {
      const data = await api(`/api/products/${buildApiPath(productId)}/settings-templates`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ settingsTemplates: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
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
    const tmpl = await api(`/api/products/${buildApiPath(productId)}/settings-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        name: normalizeLabelInput(data.name),
      }),
    })
    const activeSettingsTemplatesScope = getActiveSliceScope('settingsTemplates')
    if (activeSettingsTemplatesScope) invalidateTrackedRequest(activeSettingsTemplatesScope)
    set((s) => ({ settingsTemplates: [...s.settingsTemplates, tmpl] }))
    return tmpl
  },
  updateSettingsTemplate: async (productId, templateId, data) => {
    const requestBody = {
      ...data,
      name: data.name ? normalizeLabelInput(data.name) : data.name,
    }
    const tmpl = await api(`/api/products/${buildApiPath(productId)}/settings-templates/${buildApiPath(templateId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const activeSettingsTemplatesScope = getActiveSliceScope('settingsTemplates')
    if (activeSettingsTemplatesScope) invalidateTrackedRequest(activeSettingsTemplatesScope)
    set((s) => ({
      settingsTemplates: s.settingsTemplates.map((t) =>
        t.id === templateId ? tmpl : data.is_active ? { ...t, is_active: false } : t
      ),
    }))
  },
  deleteSettingsTemplate: async (productId, templateId) => {
    await api(
      `/api/products/${buildApiPath(productId)}/settings-templates/${buildApiPath(templateId)}`,
      { method: 'DELETE' }
    )
    const activeSettingsTemplatesScope = getActiveSliceScope('settingsTemplates')
    if (activeSettingsTemplatesScope) invalidateTrackedRequest(activeSettingsTemplatesScope)
    set((s) => ({ settingsTemplates: s.settingsTemplates.filter((t) => t.id !== templateId) }))
  },
  activateSettingsTemplate: async (productId, templateId) => {
    const tmpl = await api(`/api/products/${buildApiPath(productId)}/settings-templates/${buildApiPath(templateId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: true }),
    })
    const activeSettingsTemplatesScope = getActiveSliceScope('settingsTemplates')
    if (activeSettingsTemplatesScope) invalidateTrackedRequest(activeSettingsTemplatesScope)
    set((s) => ({
      settingsTemplates: s.settingsTemplates.map((t) =>
        t.id === templateId ? tmpl : { ...t, is_active: false }
      ),
    }))
    // Refresh product to get synced settings
    await get().fetchProduct(productId)
  },

  // Error Logs
  errorLogs: [],
  loadingErrorLogs: false,
  fetchErrorLogs: async (projectId) => {
    const requestKey = 'errorLogs'
    const requestVersion = beginTrackedRequest(requestKey)
    set({ loadingErrorLogs: true })
    try {
      const qs = buildProjectScopedQuery(projectId)
      const data = await api(`/api/error-logs?${qs}`)
      if (!isLatestRequest(requestKey, requestVersion)) return
      set({ errorLogs: data })
    } catch (error) {
      if (isLatestRequest(requestKey, requestVersion)) {
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
    const qs = buildProjectScopedQuery(projectId)
    await api(`/api/error-logs?${qs}`, { method: 'DELETE' })
    set({ errorLogs: [] })
  },

  // AI
  aiLoading: false,
  buildPrompt: async (productId, userPrompt) => {
    aiRequestCount += 1
    set({ aiLoading: true })
    try {
      const data = await api('/api/ai/build-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId.trim(),
          user_prompt: trimTextInput(userPrompt),
        }),
      })
      return data.refined_prompt
    } finally {
      aiRequestCount = Math.max(0, aiRequestCount - 1)
      set({ aiLoading: aiRequestCount > 0 })
    }
  },
  suggestPrompts: async (productId, count = 5) => {
    aiRequestCount += 1
    set({ aiLoading: true })
    try {
      const data = await api('/api/ai/suggest-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId.trim(),
          count: clampInteger(count, 1, MAX_SUGGESTED_PROMPT_COUNT, 5),
        }),
      })
      return data.prompts
    } finally {
      aiRequestCount = Math.max(0, aiRequestCount - 1)
      set({ aiLoading: aiRequestCount > 0 })
    }
  },
}))
