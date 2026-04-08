import type { ApprovalStatus, LightboxImage } from './ImageLightbox'

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'blob:'])

const sanitizeUrlCandidate = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/')) return trimmed

  try {
    const parsed = new URL(trimmed)
    if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export const sanitizeRouteSegment = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed ? encodeURIComponent(trimmed) : null
}

export const getPreviewImageUrl = (image: LightboxImage) =>
  sanitizeUrlCandidate(
    image.preview_signed_url ||
    image.preview_public_url ||
    image.thumb_signed_url ||
    image.thumb_public_url ||
    null
  )

export const getFullImageUrl = (image: LightboxImage) =>
  sanitizeUrlCandidate(
    image.signed_url ||
    image.public_url ||
    null
  )

export const getDisplayImageUrl = (image: LightboxImage) =>
  getPreviewImageUrl(image) ||
  getFullImageUrl(image)

export const getDownloadImageUrl = (
  image: LightboxImage,
  signedUrls?: {
    signed_url?: string | null
    download_url?: string | null
  } | null
) => sanitizeUrlCandidate(
  signedUrls?.download_url ||
  signedUrls?.signed_url ||
  image.download_url ||
  image.signed_url ||
  image.public_url ||
  null
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
    default:
      return { action: 'none', preventDefault: false }
  }
}
