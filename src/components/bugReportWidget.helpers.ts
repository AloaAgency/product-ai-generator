export const MAX_BUG_REPORT_IMAGES = 5
export const MAX_BUG_REPORT_FILE_SIZE = 5 * 1024 * 1024
export const ALLOWED_BUG_REPORT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export interface SelectedBugReportImage {
  file: File
  preview: string
  caption: string
}

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
  title: title.trim(),
  description: description.trim(),
  imageEntries: images.map((img, index) => ({
    imageField: `image_${index}`,
    captionField: `caption_${index}`,
    file: img.file,
    caption: img.caption || `Screenshot ${index + 1}`,
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
