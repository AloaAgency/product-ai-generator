import { randomUUID } from 'crypto'

export type GeminiImageResolution = '2K' | '4K'

export interface GeminiImageRequest {
  prompt: string
  resolution?: GeminiImageResolution
  aspectRatio?: '16:9' | '1:1' | '9:16'
  model?: string
  requestId?: string
  signal?: AbortSignal
  apiKey?: string
  /** Base64-encoded reference images to include in the request */
  referenceImages?: { mimeType: string; base64: string }[]
}

export interface GeminiImageResult {
  mimeType: string
  base64Data: string
  requestId: string
  raw: unknown
}

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview'
const DEFAULT_RESOLUTION = (process.env.GEMINI_IMAGE_RESOLUTION_DEFAULT as GeminiImageResolution) || '4K'

const resolveEndpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

const normalizeResolution = (value?: GeminiImageResolution) => (value === '2K' ? '2K' : DEFAULT_RESOLUTION)

const extractInlineImage = (response: any): { mimeType: string; data: string } | null => {
  const candidates = response?.candidates || response?.data?.candidates
  if (!Array.isArray(candidates)) return null

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts
    if (!Array.isArray(parts)) continue

    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data
      if (inline?.data && (inline?.mimeType || inline?.mime_type)) {
        return {
          mimeType: inline.mimeType || inline.mime_type,
          data: inline.data,
        }
      }
    }
  }

  return null
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [2000, 5000, 10000]

export async function generateGeminiImage(request: GeminiImageRequest): Promise<GeminiImageResult> {
  const apiKey = request.apiKey || process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('Gemini API key is not configured')
  }

  const model = request.model || DEFAULT_MODEL
  const resolution = normalizeResolution(request.resolution)
  const aspectRatio = request.aspectRatio || '16:9'
  const requestId = request.requestId || randomUUID()

  // Build parts array: reference images first, then text prompt
  const parts: any[] = []

  // Add reference images if provided
  if (request.referenceImages?.length) {
    for (const img of request.referenceImages) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      })
    }
  }

  // Add text prompt
  parts.push({ text: request.prompt })

  const payload = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio,
        imageSize: resolution,
      },
    },
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1]
      console.log(`[Gemini] Retry attempt ${attempt}/${MAX_RETRIES} after ${delay}ms delay...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }

    console.log(`[Gemini] Calling ${model} for image generation${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`)
    const response = await fetch(resolveEndpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    })

    const raw = await response.json().catch(() => ({}))

    if (!response.ok) {
      const message = raw?.error?.message || raw?.message || response.statusText
      const errorCode = raw?.error?.code || raw?.error?.status || response.status
      console.error(`[Gemini] API error (${response.status}):`, message, JSON.stringify(raw?.error || raw, null, 2))

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        lastError = new Error(response.status === 429
          ? 'Rate limit exceeded'
          : `Server error ${response.status}`)
        continue
      }

      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment and try again.')
      }
      if (response.status === 403) {
        throw new Error('API access denied. Check your GEMINI_API_KEY permissions.')
      }
      if (response.status === 404) {
        throw new Error(`Model "${model}" not found. Check GEMINI_IMAGE_MODEL setting.`)
      }
      if (response.status === 400 && message?.toLowerCase().includes('safety')) {
        throw new Error('Content blocked by safety filters. Try a different prompt.')
      }
      throw new Error(message || `Gemini error ${errorCode || response.status}`)
    }

    console.log(`[Gemini] Successfully received response`)

    const inline = extractInlineImage(raw)
    if (!inline) {
      throw new Error('Gemini response did not include image data')
    }

    return {
      mimeType: inline.mimeType,
      base64Data: inline.data,
      requestId,
      raw,
    }
  }

  throw lastError || new Error('Failed after maximum retries')
}
