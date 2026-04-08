import { describe, it, expect } from 'vitest'

import {
  isLtxModel,
  normalizeDurationValue,
  parsePositiveNumber,
  veoRequires8s,
} from '../video-constants'

describe('veoRequires8s', () => {
  it('locks Veo durations for high resolution or reference-frame generations', () => {
    expect(veoRequires8s('1080p', false, false)).toBe(true)
    expect(veoRequires8s('4k', false, false)).toBe(true)
    expect(veoRequires8s('720p', true, false)).toBe(true)
    expect(veoRequires8s('720p', false, true)).toBe(true)
    expect(veoRequires8s('720p', false, false)).toBe(false)
  })
})

describe('normalizeDurationValue', () => {
  it('rounds unsupported Veo durations to the nearest allowed value and breaks ties upward', () => {
    expect(normalizeDurationValue('veo3', 5, '720p', false, false)).toBe(6)
    expect(normalizeDurationValue('veo3', 7, '720p', false, false)).toBe(8)
    expect(normalizeDurationValue('veo3', 3.2, '720p', false, false)).toBe(4)
    expect(normalizeDurationValue('veo3', 6, '4k', false, false)).toBe(8)
  })

  it('leaves LTX durations untouched and rejects invalid values', () => {
    expect(isLtxModel('ltx-2-pro')).toBe(true)
    expect(normalizeDurationValue('ltx-2-pro', 5, '1920x1080', true, true)).toBe(5)
    expect(normalizeDurationValue('veo3', 'abc', '720p', false, false)).toBeNull()
    expect(normalizeDurationValue('veo3', 0, '720p', false, false)).toBeNull()
  })
})

describe('parsePositiveNumber', () => {
  it('accepts positive numerics and rejects empty or non-positive input', () => {
    expect(parsePositiveNumber('12')).toBe(12)
    expect(parsePositiveNumber(3.5)).toBe(3.5)
    expect(parsePositiveNumber('')).toBeNull()
    expect(parsePositiveNumber(-2)).toBeNull()
    expect(parsePositiveNumber(undefined)).toBeNull()
  })
})
