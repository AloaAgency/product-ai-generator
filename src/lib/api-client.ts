// Shared client-side fetch helpers. Use these instead of raw fetch() so
// non-2xx responses surface as errors instead of silently producing
// empty/broken UI state.

export async function api(url: string, options?: RequestInit) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export async function uploadToSignedUrl(
  signedUrl: string,
  file: File | Blob,
  contentType?: string | null
) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) {
    throw new Error(`File upload to storage failed (${res.status})`)
  }
}

// Best-effort removal of an image record whose storage upload failed, so the
// gallery doesn't show an entry with no file behind it.
export async function cleanupImageRecord(imageId: string) {
  try {
    await fetch(`/api/images/${imageId}`, { method: 'DELETE' })
  } catch {
    // The orphaned record is cosmetic; never mask the original upload error.
  }
}
