import type { ApprovalStatus, LightboxImage } from './ImageLightbox'

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'blob:'])

const sanitizeUrlCandidate = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Browsers normalize backslashes in special-scheme URLs, so `/\\attacker`
  // can become a protocol-relative request just like `//attacker`. Only allow
  // unambiguous root-relative paths here.
  if (trimmed.startsWith('/')) return trimmed.includes('\\') || trimmed.startsWith('//') ? null : trimmed

  try {
    const parsed = new URL(trimmed)
    if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

const getFirstSafeUrl = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const sanitized = sanitizeUrlCandidate(value)
    if (sanitized) return sanitized
  }

  return null
}

export const sanitizeRouteSegment = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed ? encodeURIComponent(trimmed) : null
}

export const getPreviewImageUrl = (image: LightboxImage) =>
  getFirstSafeUrl(
    image.preview_signed_url,
    image.preview_public_url,
    image.thumb_signed_url,
    image.thumb_public_url
  )

export const getFullImageUrl = (image: LightboxImage) =>
  getFirstSafeUrl(image.signed_url, image.public_url)

export const getDisplayImageUrl = (image: LightboxImage) =>
  getPreviewImageUrl(image) ||
  getFullImageUrl(image)

export const getLightboxThumbnailUrl = (image: LightboxImage) =>
  getFirstSafeUrl(
    image.thumb_signed_url,
    image.thumb_public_url,
    image.signed_url,
    image.public_url
  )

export const getDownloadImageUrl = (
  image: LightboxImage,
  signedUrls?: {
    signed_url?: string | null
    download_url?: string | null
  } | null
) => getFirstSafeUrl(
    signedUrls?.download_url,
    signedUrls?.signed_url,
    image.download_url,
    image.signed_url,
    image.public_url
  )

export const shouldRequestSignedUrls = (image: LightboxImage, hasRequester: boolean) => {
  if (!hasRequester) return false
  // Request full-size signed URL if we don't have one yet (even if a thumbnail is available)
  return !sanitizeUrlCandidate(image.signed_url) && !sanitizeUrlCandidate(image.public_url)
}

export const getNextApprovalStatus = (
  currentStatus: ApprovalStatus | undefined,
  targetStatus: Exclude<ApprovalStatus, 'pending' | null>
): ApprovalStatus => (currentStatus === targetStatus ? null : targetStatus)

export const getLightboxDisplayName = ({
  fileName,
  variationNumber,
  currentIndex,
}: {
  fileName?: string | null
  variationNumber?: number | null
  currentIndex: number
}) => fileName || `Variation ${variationNumber ?? currentIndex + 1}`

// Format an asset's generation timestamp for the lightbox header. Returns a compact
// label (e.g. "Jul 1, 2026") plus a full date+time for the hover tooltip, so users can
// correlate assets with generation dates when troubleshooting billing. Returns null for
// missing/unparseable timestamps.
export const formatGeneratedAt = (
  createdAt?: string | null
): { short: string; full: string } | null => {
  if (!createdAt) return null
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null
  return {
    short: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    full: date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }
}

export const getLightboxWarmupIndexes = (currentIndex: number) => [
  currentIndex,
  currentIndex - 1,
  currentIndex + 1,
  currentIndex - 2,
  currentIndex + 2,
]

export const getFixImageHref = ({
  projectId,
  productId,
  imageId,
}: {
  projectId?: string | null
  productId?: string | null
  imageId?: string | null
}) => {
  const safeFixProjectId = sanitizeRouteSegment(projectId)
  const safeFixProductId = sanitizeRouteSegment(productId)
  const safeFixImageId = sanitizeRouteSegment(imageId)
  return safeFixProjectId && safeFixProductId && safeFixImageId
    ? `/projects/${safeFixProjectId}/products/${safeFixProductId}/fix-image?sourceImageId=${safeFixImageId}`
    : null
}

export const buildRegenerateUrl = ({
  projectId,
  image,
}: {
  projectId?: string | null
  image: Pick<LightboxImage, 'productId' | 'prompt' | 'reference_sets'>
}) => {
  const safeProjectId = sanitizeRouteSegment(projectId)
  const safeProductId = sanitizeRouteSegment(image.productId)
  if (!safeProjectId || !safeProductId) return '#'

  const params = new URLSearchParams()
  if (image.prompt) params.set('prompt', image.prompt)
  if (image.reference_sets && image.reference_sets.length > 0) {
    params.set('reference_sets', JSON.stringify(image.reference_sets))
  }

  return `/projects/${safeProjectId}/products/${safeProductId}/generate?${params.toString()}`
}

export type LightboxKeyboardAction =
  | 'close'
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | 'approve'
  | 'reject'
  | 'download'
  | 'requestChanges'
  | 'copyPrompt'
  | 'delete'
  | 'blurNotes'
  | 'none'

export const getKeyboardAction = ({
  key,
  isNotesFocused,
  isRejected,
  hasDelete,
}: {
  key: string
  isNotesFocused: boolean
  isRejected: boolean
  hasDelete: boolean
}): { action: LightboxKeyboardAction; preventDefault: boolean } => {
  if (isNotesFocused) {
    if (key === 'Escape' || key === 'Enter') {
      return { action: 'blurNotes', preventDefault: true }
    }
    return { action: 'none', preventDefault: false }
  }

  switch (key) {
    case 'Escape':
      return { action: 'close', preventDefault: false }
    case 'ArrowLeft':
      return { action: 'prev', preventDefault: true }
    case 'ArrowRight':
      return { action: 'next', preventDefault: true }
    case 'Home':
      return { action: 'first', preventDefault: true }
    case 'End':
      return { action: 'last', preventDefault: true }
    case 'Enter':
      return { action: 'approve', preventDefault: true }
    case 'Delete':
    case 'Backspace':
      return {
        action: isRejected && hasDelete ? 'delete' : 'reject',
        preventDefault: true,
      }
    case 'a':
    case 'A':
      return { action: 'approve', preventDefault: false }
    case 'r':
    case 'R':
      return { action: 'reject', preventDefault: false }
    case 'd':
    case 'D':
      return { action: 'download', preventDefault: false }
    case 'c':
    case 'C':
      return { action: 'requestChanges', preventDefault: false }
    case 'p':
    case 'P':
      return { action: 'copyPrompt', preventDefault: false }
    default:
      return { action: 'none', preventDefault: false }
  }
}
