import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isLtxModel,
  normalizeDurationValue,
  parsePositiveNumber,
  veoRequires8s,
} from '../video-constants.js'

test('veoRequires8s locks Veo durations for high resolution or reference-frame generations', () => {
  assert.equal(veoRequires8s('1080p', false, false), true)
  assert.equal(veoRequires8s('4k', false, false), true)
  assert.equal(veoRequires8s('720p', true, false), true)
  assert.equal(veoRequires8s('720p', false, true), true)
  assert.equal(veoRequires8s('720p', false, false), false)
})

test('normalizeDurationValue rounds unsupported Veo durations to the nearest allowed value and breaks ties upward', () => {
  assert.equal(normalizeDurationValue('veo3', 5, '720p', false, false), 6)
  assert.equal(normalizeDurationValue('veo3', 7, '720p', false, false), 8)
  assert.equal(normalizeDurationValue('veo3', 3.2, '720p', false, false), 4)
  assert.equal(normalizeDurationValue('veo3', 6, '4k', false, false), 8)
})

test('normalizeDurationValue leaves LTX durations untouched and rejects invalid values', () => {
  assert.equal(isLtxModel('ltx-2-pro'), true)
  assert.equal(normalizeDurationValue('ltx-2-pro', 5, '1920x1080', true, true), 5)
  assert.equal(normalizeDurationValue('veo3', 'abc', '720p', false, false), null)
  assert.equal(normalizeDurationValue('veo3', 0, '720p', false, false), null)
})

test('parsePositiveNumber accepts positive numerics and rejects empty or non-positive input', () => {
  assert.equal(parsePositiveNumber('12'), 12)
  assert.equal(parsePositiveNumber(3.5), 3.5)
  assert.equal(parsePositiveNumber(''), null)
  assert.equal(parsePositiveNumber(-2), null)
  assert.equal(parsePositiveNumber(undefined), null)
})
