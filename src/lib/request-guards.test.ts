import { describe, it, expect } from 'vitest'
import { sanitizeStorageFileExtension } from './request-guards'

describe('sanitizeStorageFileExtension', () => {
  it('returns lowercased extension for normal file names', () => {
    expect(sanitizeStorageFileExtension('photo.PNG')).toBe('.png')
    expect(sanitizeStorageFileExtension('clip.webp')).toBe('.webp')
    expect(sanitizeStorageFileExtension('archive.tar.gz')).toBe('.gz')
  })

  it('returns empty string when there is no extension', () => {
    expect(sanitizeStorageFileExtension('README')).toBe('')
    expect(sanitizeStorageFileExtension('')).toBe('')
    expect(sanitizeStorageFileExtension('trailing.')).toBe('')
  })

  it('rejects extensions containing path separators', () => {
    expect(sanitizeStorageFileExtension('photo.png/../../evil')).toBe('')
    expect(sanitizeStorageFileExtension('photo.png/evil')).toBe('')
    expect(sanitizeStorageFileExtension('photo.a\\b')).toBe('')
  })

  it('rejects non-alphanumeric or overlong extensions', () => {
    expect(sanitizeStorageFileExtension('file.p n g')).toBe('')
    expect(sanitizeStorageFileExtension('file.png?x=1')).toBe('')
    expect(sanitizeStorageFileExtension('file.verylongextension')).toBe('')
  })

  it('handles non-string input defensively', () => {
    expect(sanitizeStorageFileExtension(undefined as unknown as string)).toBe('')
    expect(sanitizeStorageFileExtension(123 as unknown as string)).toBe('')
  })
})
