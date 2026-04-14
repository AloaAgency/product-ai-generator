export const MAX_BUG_REPORT_IMAGES = 5
export const MAX_BUG_REPORT_FILE_SIZE = 5 * 1024 * 1024
export const ALLOWED_BUG_REPORT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const MAX_BUG_REPORT_TITLE_LENGTH = 120
export const MAX_BUG_REPORT_DESCRIPTION_LENGTH = 2000
export const MAX_BUG_REPORT_CAPTION_LENGTH = 160
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export interface SelectedBugReportImage {
  file: File
  preview: string
  caption: string
}

export const clampBugReportText = (value: string, maxLength: number) => value.slice(0, maxLength)

export const stripBugReportControlChars = (value: string) => value.replace(CONTROL_CHARS, '')

const trimAndStripControlChars = (value: string) => stripBugReportControlChars(value).trim()

export const normalizeBugReportSingleLine = (value: string, maxLength: number) =>
  clampBugReportText(trimAndStripControlChars(value).replace(/\s+/g, ' '), maxLength)

export const normalizeBugReportMultiline = (value: string, maxLength: number) =>
  clampBugReportText(
    trimAndStripControlChars(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
    maxLength
  )

export const validateBugReportFiles = ({
  currentCount,
  files,
}: {
  currentCount: number
  files: File[]
}) => {
  const acceptedFiles: File[] = []
  const errors: string[] = []

  files.forEach((file) => {
    if (currentCount + acceptedFiles.length >= MAX_BUG_REPORT_IMAGES) {
      errors.push(`Maximum ${MAX_BUG_REPORT_IMAGES} images allowed`)
      return
    }
    if (!ALLOWED_BUG_REPORT_TYPES.includes(file.type)) {
      errors.push(`${file.name}: Invalid file type`)
      return
    }
    if (file.size > MAX_BUG_REPORT_FILE_SIZE) {
      errors.push(`${file.name}: File too large (max 5MB)`)
      return
    }
    acceptedFiles.push(file)
  })

  return { acceptedFiles, errors }
}

export const buildBugReportSubmission = ({
  type,
  title,
  description,
  images,
}: {
  type: 'bug' | 'feature'
  title: string
  description: string
  images: SelectedBugReportImage[]
}) => ({
  type,
  title: normalizeBugReportSingleLine(title, MAX_BUG_REPORT_TITLE_LENGTH),
  description: normalizeBugReportMultiline(description, MAX_BUG_REPORT_DESCRIPTION_LENGTH),
  imageEntries: images.map((img, index) => ({
    imageField: `image_${index}`,
    captionField: `caption_${index}`,
    file: img.file,
    caption: normalizeBugReportSingleLine(img.caption, MAX_BUG_REPORT_CAPTION_LENGTH) || `Screenshot ${index + 1}`,
  })),
  imageCount: String(images.length),
})

export const parseBugReportResponse = (raw: string) => {
  try {
    return JSON.parse(raw) as { success?: boolean; message?: string } | null
  } catch {
    return null
  }
}

export const buildSelectedBugReportImages = (files: File[]): SelectedBugReportImage[] =>
  files.map((file) => ({
    file,
    preview: URL.createObjectURL(file),
    caption: '',
  }))

export const releaseBugReportImagePreviews = (images: Pick<SelectedBugReportImage, 'preview'>[]) => {
  images.forEach((image) => URL.revokeObjectURL(image.preview))
}

export const createBugReportFormData = ({
  type,
  title,
  description,
  images,
}: {
  type: 'bug' | 'feature'
  title: string
  description: string
  images: SelectedBugReportImage[]
}) => {
  const submission = buildBugReportSubmission({
    type,
    title,
    description,
    images,
  })
  const formData = new FormData()
  formData.append('type', submission.type)
  formData.append('title', submission.title)
  formData.append('description', submission.description)
  submission.imageEntries.forEach((entry) => {
    formData.append(entry.imageField, entry.file)
    formData.append(entry.captionField, entry.caption)
  })
  formData.append('imageCount', submission.imageCount)
  return formData
}
