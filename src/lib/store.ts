'use client'

import { create } from 'zustand'
import type {
  Product,
  ReferenceSet,
  ReferenceImage,
  PromptTemplate,
  GenerationJob,
  GeneratedImage,
} from './types'

interface AppState {
  // Products
  products: Product[]
  currentProduct: Product | null
  loadingProducts: boolean
  fetchProducts: () => Promise<void>
  fetchProduct: (id: string) => Promise<void>
  createProduct: (data: { name: string; description?: string }) => Promise<Product>
  updateProduct: (id: string, data: Partial<Pick<Product, 'name' | 'description' | 'global_style_settings'>>) => Promise<void>
  deleteProduct: (id: string) => Promise<void>

  // Reference Sets
  referenceSets: ReferenceSet[]
  loadingRefSets: boolean
  fetchReferenceSets: (productId: string) => Promise<void>
  createReferenceSet: (productId: string, data: { name: string; description?: string }) => Promise<ReferenceSet>
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
  }) => Promise<GenerationJob>
  fetchJobStatus: (productId: string, jobId: string) => Promise<void>

  // Gallery
  galleryImages: GeneratedImage[]
  loadingGallery: boolean
  fetchGallery: (productId: string, filters?: { job_id?: string; approval_status?: string; media_type?: string; scene_id?: string }) => Promise<void>
  updateImageApproval: (imageId: string, approval_status: string | null, notes?: string) => Promise<void>
  deleteImage: (imageId: string) => Promise<void>

  // AI
  aiLoading: boolean
  buildPrompt: (productId: string, userPrompt: string) => Promise<string>
  suggestPrompts: (productId: string, count?: number) => Promise<{ name: string; prompt_text: string }[]>
}

const api = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export const useAppStore = create<AppState>((set, get) => ({
  // Products
  products: [],
  currentProduct: null,
  loadingProducts: false,
  fetchProducts: async () => {
    set({ loadingProducts: true })
    try {
      const data = await api('/api/products')
      set({ products: data })
    } finally {
      set({ loadingProducts: false })
    }
  },
  fetchProduct: async (id) => {
    const data = await api(`/api/products/${id}`)
    set({ currentProduct: data })
  },
  createProduct: async (data) => {
    const product = await api('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({ products: [product, ...s.products] }))
    return product
  },
  updateProduct: async (id, data) => {
    const product = await api(`/api/products/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({
      currentProduct: s.currentProduct?.id === id ? product : s.currentProduct,
      products: s.products.map((p) => (p.id === id ? product : p)),
    }))
  },
  deleteProduct: async (id) => {
    await api(`/api/products/${id}`, { method: 'DELETE' })
    set((s) => ({
      products: s.products.filter((p) => p.id !== id),
      currentProduct: s.currentProduct?.id === id ? null : s.currentProduct,
    }))
  },

  // Reference Sets
  referenceSets: [],
  loadingRefSets: false,
  fetchReferenceSets: async (productId) => {
    set({ loadingRefSets: true })
    try {
      const data = await api(`/api/products/${productId}/reference-sets`)
      set({ referenceSets: data })
    } finally {
      set({ loadingRefSets: false })
    }
  },
  createReferenceSet: async (productId, data) => {
    const refSet = await api(`/api/products/${productId}/reference-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({ referenceSets: [...s.referenceSets, refSet] }))
    return refSet
  },
  updateReferenceSet: async (productId, setId, data) => {
    const refSet = await api(`/api/products/${productId}/reference-sets/${setId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({
      referenceSets: s.referenceSets.map((r) =>
        r.id === setId ? refSet : data.is_active ? { ...r, is_active: false } : r
      ),
    }))
  },
  deleteReferenceSet: async (productId, setId) => {
    await api(`/api/products/${productId}/reference-sets/${setId}`, { method: 'DELETE' })
    set((s) => ({ referenceSets: s.referenceSets.filter((r) => r.id !== setId) }))
  },

  // Reference Images
  referenceImages: {},
  fetchReferenceImages: async (productId, setId) => {
    try {
      const data = await api(`/api/products/${productId}/reference-sets/${setId}/images`)
      set((s) => ({ referenceImages: { ...s.referenceImages, [setId]: data } }))
    } catch (err) {
      console.error('[ReferenceImages] Failed to fetch images', err)
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
      `/api/products/${productId}/reference-sets/${setId}/images/upload-urls`,
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
      const data = await api(`/api/products/${productId}/reference-sets/${setId}/images`, {
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
    await api(`/api/products/${productId}/reference-sets/${setId}/images/${imgId}`, { method: 'DELETE' })
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
    const data = await api(`/api/products/${productId}/prompts`)
    set({ promptTemplates: data })
  },
  createPromptTemplate: async (productId, data) => {
    const tmpl = await api(`/api/products/${productId}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({ promptTemplates: [...s.promptTemplates, tmpl] }))
    return tmpl
  },
  updatePromptTemplate: async (productId, promptId, data) => {
    const tmpl = await api(`/api/products/${productId}/prompts/${promptId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    set((s) => ({ promptTemplates: s.promptTemplates.map((p) => (p.id === promptId ? tmpl : p)) }))
  },
  deletePromptTemplate: async (productId, promptId) => {
    await api(`/api/products/${productId}/prompts/${promptId}`, { method: 'DELETE' })
    set((s) => ({ promptTemplates: s.promptTemplates.filter((p) => p.id !== promptId) }))
  },

  // Generation
  generationJobs: [],
  currentJob: null,
  loadingJobs: false,
  fetchGenerationJobs: async (productId) => {
    const shouldShowLoading = get().generationJobs.length === 0
    if (shouldShowLoading) set({ loadingJobs: true })
    try {
      const data = await api(`/api/products/${productId}/generate`)
      set({ generationJobs: data })
    } catch (err) {
      console.error('[GenerationJobs] Failed to fetch jobs', err)
    } finally {
      if (shouldShowLoading) set({ loadingJobs: false })
    }
  },
  startGeneration: async (productId, data) => {
    const result = await api(`/api/products/${productId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const job = result.job ?? result
    set((s) => ({ generationJobs: [job, ...s.generationJobs] }))
    return job
  },
  fetchJobStatus: async (productId, jobId) => {
    const data = await api(`/api/products/${productId}/generate/${jobId}`)
    set({ currentJob: { ...data.job, images: data.images } })
  },

  // Gallery
  galleryImages: [],
  loadingGallery: false,
  fetchGallery: async (productId, filters) => {
    const shouldShowLoading = get().galleryImages.length === 0
    if (shouldShowLoading) set({ loadingGallery: true })
    try {
      const params = new URLSearchParams()
      if (filters?.job_id) params.set('job_id', filters.job_id)
      if (filters?.approval_status) params.set('approval_status', filters.approval_status)
      if (filters?.media_type) params.set('media_type', filters.media_type)
      if (filters?.scene_id) params.set('scene_id', filters.scene_id)
      const qs = params.toString()
      const data = await api(`/api/products/${productId}/gallery${qs ? `?${qs}` : ''}`)
      set({ galleryImages: data.images ?? data })
    } finally {
      if (shouldShowLoading) set({ loadingGallery: false })
    }
  },
  updateImageApproval: async (imageId, approval_status, notes) => {
    const data = await api(`/api/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_status, notes }),
    })
    const updated = data.image ?? data
    set((s) => ({
      galleryImages: s.galleryImages.map((i) => (i.id === imageId ? updated : i)),
    }))
  },
  deleteImage: async (imageId) => {
    await api(`/api/images/${imageId}`, { method: 'DELETE' })
    set((s) => ({
      galleryImages: s.galleryImages.filter((i) => i.id !== imageId),
    }))
  },

  // AI
  aiLoading: false,
  buildPrompt: async (productId, userPrompt) => {
    set({ aiLoading: true })
    try {
      const data = await api('/api/ai/build-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, user_prompt: userPrompt }),
      })
      return data.refined_prompt
    } finally {
      set({ aiLoading: false })
    }
  },
  suggestPrompts: async (productId, count = 5) => {
    set({ aiLoading: true })
    try {
      const data = await api('/api/ai/suggest-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, count }),
      })
      return data.prompts
    } finally {
      set({ aiLoading: false })
    }
  },
}))
