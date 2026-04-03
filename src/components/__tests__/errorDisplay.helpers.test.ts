import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getSafeDownloadErrorMessage,
  getSafeErrorContext,
  getSafeErrorMessage,
  getSafeQueueErrorMessage,
} from '../errorDisplay.helpers.js'

test('getSafeErrorMessage preserves short customer-safe messages', () => {
  assert.equal(getSafeErrorMessage('Image upload timed out. Please try again.'), 'Image upload timed out. Please try again.')
})

test('getSafeErrorMessage hides stack traces and obvious internal details', () => {
  assert.equal(
    getSafeErrorMessage('Error: boom\n    at submit (/app/node_modules/file.js:1:2)'),
    'Something went wrong. Try again or contact support if the issue persists.'
  )
  assert.equal(
    getSafeQueueErrorMessage('SQLSTATE 23505 duplicate key value violates unique constraint'),
    'Generation failed. Try again or review your prompt and settings.'
  )
})

test('getSafeDownloadErrorMessage falls back to a generic customer-facing message', () => {
  assert.equal(getSafeDownloadErrorMessage('<html>502 Bad Gateway</html>'), 'Download failed. Please try again.')
})

test('getSafeErrorContext redacts secrets and truncates large payloads', () => {
  const context = getSafeErrorContext({
    request: {
      authorization: 'Bearer secret-token',
      token: 'secret-token',
      detail: 'x'.repeat(1300),
    },
  })

  assert.ok(context)
  assert.match(context || '', /\[redacted\]/)
  assert.doesNotMatch(context || '', /secret-token/)
  assert.ok((context || '').length <= 1200)
})
