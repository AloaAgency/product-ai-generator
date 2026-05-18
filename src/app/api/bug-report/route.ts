import { NextRequest, NextResponse } from 'next/server'
import {
  ALLOWED_BUG_REPORT_TYPES,
  MAX_BUG_REPORT_CAPTION_LENGTH,
  MAX_BUG_REPORT_DESCRIPTION_LENGTH,
  MAX_BUG_REPORT_FILE_SIZE,
  MAX_BUG_REPORT_IMAGES,
  MAX_BUG_REPORT_TITLE_LENGTH,
  normalizeBugReportMultiline,
  normalizeBugReportSingleLine,
} from '@/components/bugReportWidget.helpers'

const BFT_API_KEY = process.env.BFT_API_KEY?.replace(/"/g, '') || ''
const BFT_BASE_URL = process.env.BFT_BASE_URL?.replace(/"/g, '') || ''

interface ImageUpload {
  file: File
  caption: string
}

const SECRET_TEXT_PATTERNS = [
  /([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi,
  /((?:api[_-]?key|authorization|secret|signature|token|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi,
]

const redactSensitiveText = (value: string) =>
  SECRET_TEXT_PATTERNS.reduce((current, pattern) => current.replace(pattern, '$1[redacted]'), value)

const getSafeBugReportError = (error: unknown) =>
  redactSensitiveText(error instanceof Error ? error.message : String(error ?? 'unknown error')).slice(0, 240)

const validateBugReportImage = (file: File) => {
  if (!ALLOWED_BUG_REPORT_TYPES.includes(file.type)) {
    return 'Unsupported screenshot format'
  }
  if (file.size > MAX_BUG_REPORT_FILE_SIZE) {
    return 'Screenshot exceeds 5MB limit'
  }
  return null
}

async function uploadImageToTracker(itemId: string, image: ImageUpload): Promise<boolean> {
  try {
    if (!image.file) return false

    const arrayBuffer = await image.file.arrayBuffer()
    const blob = new Blob([arrayBuffer], { type: image.file.type })

    const formData = new FormData()
    formData.append('file', blob, image.file.name)
    formData.append('caption', image.caption)
    formData.append('uploaded_by', 'aloa-ai-product-imager')

    const response = await fetch(`${BFT_BASE_URL}/public/items/${itemId}/attachments`, {
      method: 'POST',
      headers: { 'x-api-key': BFT_API_KEY },
      body: formData,
    })

    if (!response.ok) {
      const raw = await response.text()
      console.error(`[BugReport] Upload failed (${response.status}): ${redactSensitiveText(raw)}`)
      return false
    }

    return true
  } catch (error) {
    console.error('[BugReport] Upload exception:', getSafeBugReportError(error))
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || ''
    let type: string
    let title: string
    let description: string
    const images: ImageUpload[] = []

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      type = formData.get('type') as string
      title = formData.get('title') as string
      description = formData.get('description') as string

      const imageCount = Math.max(0, Math.trunc(Number(formData.get('imageCount')) || 0))
      if (imageCount > MAX_BUG_REPORT_IMAGES) {
        return NextResponse.json(
          { success: false, message: `Maximum ${MAX_BUG_REPORT_IMAGES} images allowed` },
          { status: 400 }
        )
      }
      for (let i = 0; i < imageCount; i++) {
        const file = formData.get(`image_${i}`) as File | null
        const caption = normalizeBugReportSingleLine(
          (formData.get(`caption_${i}`) as string) || `Screenshot ${i + 1}`,
          MAX_BUG_REPORT_CAPTION_LENGTH
        ) || `Screenshot ${i + 1}`
        if (file && file instanceof File) {
          const imageError = validateBugReportImage(file)
          if (imageError) {
            return NextResponse.json({ success: false, message: `${file.name}: ${imageError}` }, { status: 400 })
          }
          images.push({ file, caption })
        }
      }
    } else {
      const body = await request.json()
      type = body.type
      title = body.title
      description = body.description
    }

    if (!type || !title || !description) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields: type, title, and description' },
        { status: 400 }
      )
    }

    if (type !== 'bug' && type !== 'feature') {
      return NextResponse.json(
        { success: false, message: 'Invalid type: must be "bug" or "feature"' },
        { status: 400 }
      )
    }

    title = normalizeBugReportSingleLine(title, MAX_BUG_REPORT_TITLE_LENGTH)
    description = normalizeBugReportMultiline(description, MAX_BUG_REPORT_DESCRIPTION_LENGTH)

    if (!title || !description) {
      return NextResponse.json(
        { success: false, message: 'Title and description are required' },
        { status: 400 }
      )
    }

    const enhancedDescription = `${description}\n\n---\nTimestamp: ${new Date().toISOString()}\nApp: Aloa AI Product Imager${images.length > 0 ? `\nAttachments: ${images.length} image(s)` : ''}`

    let trackerResponseOk = false
    let itemId: string | null = null

    try {
      const response = await fetch(`${BFT_BASE_URL}/public/items`, {
        method: 'POST',
        headers: {
          'x-api-key': BFT_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type, title, description: enhancedDescription }),
      })

      if (response.ok) {
        trackerResponseOk = true
        const data = await response.json()
        itemId = data?.data?.id
      } else {
        console.error('Bug tracker API error:', redactSensitiveText(await response.text()))
      }
    } catch (trackerError) {
      console.error('Bug tracker API request failed:', getSafeBugReportError(trackerError))
    }

    let imagesUploaded = 0
    if (trackerResponseOk && itemId && images.length > 0) {
      for (const image of images) {
        if (await uploadImageToTracker(itemId, image)) imagesUploaded++
      }
    }

    const imageMessage = images.length > 0
      ? imagesUploaded === images.length
        ? ` with ${imagesUploaded} screenshot${imagesUploaded !== 1 ? 's' : ''}`
        : imagesUploaded > 0
          ? ` (${imagesUploaded}/${images.length} screenshots uploaded)`
          : ' (screenshots failed to upload)'
      : ''

    return NextResponse.json(
      {
        success: true,
        message: trackerResponseOk
          ? `${type === 'bug' ? 'Bug' : 'Feature'} report submitted successfully${imageMessage}`
          : 'Report received—tracker temporarily unavailable.',
      },
      { status: trackerResponseOk ? 200 : 202 }
    )
  } catch (error) {
    console.error('Error submitting bug report:', getSafeBugReportError(error))
    return NextResponse.json(
      { success: false, message: 'Failed to submit report.' },
      { status: 500 }
    )
  }
}
