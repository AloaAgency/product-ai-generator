const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const DEFAULT_MAX_ERROR_MESSAGE_LENGTH = 200

export const MAX_PROMPT_TEXT_LENGTH = 10_000
export const MAX_REFERENCE_IMAGES = 14
export const MAX_REFERENCE_IMAGE_SIZE_BYTES = 50 * 1024 * 1024
export const ALLOWED_REFERENCE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])
export const IMAGE_APPROVAL_STATUSES = new Set([
  'approved',
  'rejected',
  'pending',
  'request_changes',
])
export const GALLERY_MEDIA_TYPES = new Set(['image', 'video', 'all'])
export const GALLERY_SORT_OPTIONS = new Set(['oldest', 'variation'])

type PublicErrorOptions = {
  fallback?: string
  maxLength?: number
}

export type GalleryFiltersInput = {
  job_id?: string
  approval_status?: string
  media_type?: string
  scene_id?: string
  sort?: string
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim())
}

export function requireUuid(value: string, fieldName = 'id'): string {
  const normalized = value.trim()
  if (!isUuid(normalized)) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return normalized
}

export function optionalUuid(value: string | null | undefined, fieldName = 'id'): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return requireUuid(normalized, fieldName)
}

export function sanitizeUuidArray(values: string[], fieldName = 'id'): string[] {
  const normalized = Array.from(new Set(values.map((value) => requireUuid(value, fieldName))))
  if (normalized.length === 0) {
    throw new Error(`At least one valid ${fieldName} is required`)
  }
  return normalized
}

export function sanitizeApprovalStatus(
  value: string | null | undefined,
  options: { allowNull?: boolean; allowAll?: boolean } = {}
): string | null | undefined {
  if (value == null) return options.allowNull ? null : undefined

  const normalized = value.trim()
  if (!normalized) return options.allowNull ? null : undefined
  if (options.allowAll && normalized === 'all') return normalized
  if (!IMAGE_APPROVAL_STATUSES.has(normalized)) {
    throw new Error('Invalid approval status')
  }
  return normalized
}

export function sanitizeGalleryFilters(filters?: GalleryFiltersInput): GalleryFiltersInput | undefined {
  if (!filters) return undefined

  const sanitized: GalleryFiltersInput = {}
  const jobId = optionalUuid(filters.job_id, 'job id')
  const sceneId = optionalUuid(filters.scene_id, 'scene id')
  const approvalStatus = sanitizeApprovalStatus(filters.approval_status)
  const mediaType = typeof filters.media_type === 'string' ? filters.media_type.trim() : ''
  const sort = typeof filters.sort === 'string' ? filters.sort.trim() : ''

  if (jobId) sanitized.job_id = jobId
  if (sceneId) sanitized.scene_id = sceneId
  if (approvalStatus) sanitized.approval_status = approvalStatus

  if (mediaType) {
    if (!GALLERY_MEDIA_TYPES.has(mediaType)) {
      throw new Error('Invalid media type')
    }
    sanitized.media_type = mediaType
  }

  if (sort) {
    if (!GALLERY_SORT_OPTIONS.has(sort)) {
      throw new Error('Invalid gallery sort')
    }
    sanitized.sort = sort
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

export function sanitizePromptText(value: string, fieldName = 'prompt'): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${fieldName} is required`)
  }
  if (normalized.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new Error(`${fieldName} must be ${MAX_PROMPT_TEXT_LENGTH} characters or fewer`)
  }
  return normalized
}

export function validateReferenceUploadFiles(files: File[]): File[] {
  if (files.length === 0) {
    throw new Error('No files provided')
  }
  if (files.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Cannot upload more than ${MAX_REFERENCE_IMAGES} files at once`)
  }

  for (const file of files) {
    if (!ALLOWED_REFERENCE_IMAGE_TYPES.has(file.type)) {
      throw new Error(`File type "${file.type}" is not allowed`)
    }
    if (file.size > MAX_REFERENCE_IMAGE_SIZE_BYTES) {
      throw new Error(`File "${file.name}" exceeds the 50 MB size limit`)
    }
  }

  return files
}

export function sanitizePublicErrorMessage(
  error: unknown,
  options: PublicErrorOptions = {}
): string {
  const fallback = options.fallback ?? 'Request failed'
  const maxLength = options.maxLength ?? DEFAULT_MAX_ERROR_MESSAGE_LENGTH
  const rawMessage = (() => {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string') return error
    if (error == null) return ''
    return String(error)
  })()

  const normalized = rawMessage
    .replace(/\s+/g, ' ')
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|authorization|secret|signature|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .trim()

  if (!normalized) return fallback
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}
