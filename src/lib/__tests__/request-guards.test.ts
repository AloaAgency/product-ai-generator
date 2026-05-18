import { describe, expect, it } from 'vitest'
import {
  sanitizeApprovalStatus,
  sanitizeGalleryFilters,
  sanitizePromptText,
  sanitizePublicErrorMessage,
  sanitizeUuidArray,
  validateReferenceUploadFiles,
} from '@/lib/request-guards'

describe('request-guards', () => {
  it('accepts canonical UUIDs and de-duplicates arrays', () => {
    const ids = sanitizeUuidArray([
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440000',
    ], 'image id')

    expect(ids).toEqual(['550e8400-e29b-41d4-a716-446655440000'])
  })

  it('rejects malformed UUIDs', () => {
    expect(() => sanitizeUuidArray(['../etc/passwd'], 'image id')).toThrow('Invalid image id')
  })

  it('allows only known gallery filters', () => {
    expect(sanitizeGalleryFilters({
      job_id: '550e8400-e29b-41d4-a716-446655440000',
      approval_status: 'pending',
      media_type: 'video',
      scene_id: '550e8400-e29b-41d4-a716-446655440001',
      sort: 'variation',
    })).toEqual({
      job_id: '550e8400-e29b-41d4-a716-446655440000',
      approval_status: 'pending',
      media_type: 'video',
      scene_id: '550e8400-e29b-41d4-a716-446655440001',
      sort: 'variation',
    })

    expect(() => sanitizeGalleryFilters({ media_type: 'javascript:alert(1)' })).toThrow('Invalid media type')
  })

  it('redacts tokens from public error messages', () => {
    const message = sanitizePublicErrorMessage(
      'GET /api?access_token=secret Bearer abc123 api_key=shh'
    )

    expect(message).not.toContain('secret')
    expect(message).not.toContain('abc123')
    expect(message).not.toContain('shh')
    expect(message).toContain('[redacted]')
  })

  it('rejects empty prompts and invalid approval statuses', () => {
    expect(() => sanitizePromptText('   ', 'prompt_text')).toThrow('prompt_text is required')
    expect(() => sanitizeApprovalStatus('ship-it')).toThrow('Invalid approval status')
  })

  it('validates reference upload files before requesting signed urls', () => {
    const validFile = new File(['ok'], 'image.png', { type: 'image/png' })
    expect(validateReferenceUploadFiles([validFile])).toEqual([validFile])

    const invalidFile = new File(['bad'], 'payload.svg', { type: 'image/svg+xml' })
    expect(() => validateReferenceUploadFiles([invalidFile])).toThrow('File type "image/svg+xml" is not allowed')
  })
})
