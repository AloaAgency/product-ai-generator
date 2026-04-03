import type { ApprovalStatus, LightboxImage } from './ImageLightbox'

export const getDisplayImageUrl = (image: LightboxImage) =>
  image.preview_signed_url ||
  image.preview_public_url ||
  image.thumb_signed_url ||
  image.thumb_public_url ||
  image.signed_url ||
  image.public_url ||
  null

export const getDownloadImageUrl = (
  image: LightboxImage,
  signedUrls?: {
    signed_url?: string | null
    download_url?: string | null
  } | null
) => signedUrls?.download_url || signedUrls?.signed_url || image.download_url || image.signed_url || image.public_url || null

export const shouldRequestSignedUrls = (image: LightboxImage, hasRequester: boolean) => {
  if (!hasRequester) return false
  return !getDisplayImageUrl(image)
}

export const getNextApprovalStatus = (
  currentStatus: ApprovalStatus | undefined,
  targetStatus: Exclude<ApprovalStatus, 'pending' | null>
): ApprovalStatus => (currentStatus === targetStatus ? null : targetStatus)

export type LightboxKeyboardAction =
  | 'close'
  | 'prev'
  | 'next'
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
      return { action: 'prev', preventDefault: false }
    case 'ArrowRight':
      return { action: 'next', preventDefault: false }
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
