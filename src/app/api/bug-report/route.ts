import { NextRequest, NextResponse } from 'next/server'

const BFT_API_KEY = process.env.BFT_API_KEY?.replace(/"/g, '') || ''
const BFT_BASE_URL = process.env.BFT_BASE_URL?.replace(/"/g, '') || ''

interface ImageUpload {
  file: File
  caption: string
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
      console.error(`[BugReport] Upload failed (${response.status}): ${raw}`)
      return false
    }

    return true
  } catch (error) {
    console.error('[BugReport] Upload exception:', error)
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

      const imageCount = parseInt(formData.get('imageCount') as string) || 0
      for (let i = 0; i < imageCount; i++) {
        const file = formData.get(`image_${i}`) as File | null
        const caption = formData.get(`caption_${i}`) as string || `Screenshot ${i + 1}`
        if (file && file instanceof File) {
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

    title = title.trim().replace(/\s+/g, ' ').slice(0, 200)
    description = description.trim()

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
        console.error('Bug tracker API error:', await response.text())
      }
    } catch (trackerError) {
      console.error('Bug tracker API request failed:', trackerError)
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
    console.error('Error submitting bug report:', error)
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to submit report.' },
      { status: 500 }
    )
  }
}
