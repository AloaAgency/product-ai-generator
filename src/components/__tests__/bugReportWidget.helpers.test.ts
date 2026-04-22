import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSelectedBugReportImages,
  buildBugReportSubmission,
  clampBugReportText,
  createBugReportFormData,
  MAX_BUG_REPORT_CAPTION_LENGTH,
  MAX_BUG_REPORT_DESCRIPTION_LENGTH,
  MAX_BUG_REPORT_FILE_SIZE,
  normalizeBugReportMultiline,
  normalizeBugReportSingleLine,
  parseBugReportResponse,
  stripBugReportControlChars,
  validateBugReportFiles,
  type SelectedBugReportImage,
} from '../bugReportWidget.helpers.js'

const createFile = ({ name, type, size }: { name: string; type: string; size: number }) =>
  new File([new Uint8Array(size)], name, { type })

test('validateBugReportFiles rejects invalid types and oversize files without dropping valid images', () => {
  const result = validateBugReportFiles({
    currentCount: 3,
    files: [
      createFile({ name: 'ok.png', type: 'image/png', size: 10 }),
      createFile({ name: 'bad.txt', type: 'text/plain', size: 10 }),
      createFile({ name: 'large.jpg', type: 'image/jpeg', size: MAX_BUG_REPORT_FILE_SIZE + 1 }),
    ],
  })

  assert.deepEqual(result.acceptedFiles.map((file) => file.name), ['ok.png'])
  assert.deepEqual(result.errors, [
    'bad.txt: Invalid file type',
    'large.jpg: File too large (max 5MB)',
  ])
})

test('validateBugReportFiles caps uploads once the screenshot limit is reached', () => {
  const result = validateBugReportFiles({
    currentCount: 5,
    files: [createFile({ name: 'extra.png', type: 'image/png', size: 10 })],
  })

  assert.deepEqual(result.acceptedFiles, [])
  assert.deepEqual(result.errors, ['Maximum 5 images allowed'])
})

test('buildBugReportSubmission trims fields and fills default screenshot captions', () => {
  const images: SelectedBugReportImage[] = [
    { file: createFile({ name: 'one.png', type: 'image/png', size: 10 }), preview: 'blob:1', caption: '' },
    { file: createFile({ name: 'two.png', type: 'image/png', size: 10 }), preview: 'blob:2', caption: 'Keep this' },
  ]

  const submission = buildBugReportSubmission({
    type: 'feature',
    title: '  Add queue filters  ',
    description: '  More precise filtering please  ',
    images,
  })

  assert.equal(submission.title, 'Add queue filters')
  assert.equal(submission.description, 'More precise filtering please')
  assert.equal(submission.imageCount, '2')
  assert.deepEqual(
    submission.imageEntries.map((entry) => ({ imageField: entry.imageField, caption: entry.caption })),
    [
      { imageField: 'image_0', caption: 'Screenshot 1' },
      { imageField: 'image_1', caption: 'Keep this' },
    ]
  )
})

test('bug report normalization removes control characters and preserves safe multiline formatting', () => {
  assert.equal(
    normalizeBugReportSingleLine('  bad\u0000  title \n here ', 120),
    'bad title here'
  )
  assert.equal(
    normalizeBugReportMultiline('line 1\r\n\r\n\r\nline 2\u0007', MAX_BUG_REPORT_DESCRIPTION_LENGTH),
    'line 1\n\nline 2'
  )
})

test('parseBugReportResponse tolerates non-JSON error bodies', () => {
  assert.deepEqual(parseBugReportResponse('{\"success\":true,\"message\":\"ok\"}'), {
    success: true,
    message: 'ok',
  })
  assert.equal(parseBugReportResponse('gateway timeout'), null)
})

test('clampBugReportText enforces per-field limits before submission', () => {
  assert.equal(clampBugReportText('short', MAX_BUG_REPORT_CAPTION_LENGTH), 'short')
  assert.equal(
    clampBugReportText('x'.repeat(MAX_BUG_REPORT_CAPTION_LENGTH + 10), MAX_BUG_REPORT_CAPTION_LENGTH).length,
    MAX_BUG_REPORT_CAPTION_LENGTH
  )
})

test('bug report helpers centralize control-char stripping and form-data creation', () => {
  assert.equal(stripBugReportControlChars('bad\u0000 title\u0007'), 'bad title')

  const images = buildSelectedBugReportImages([
    createFile({ name: 'one.png', type: 'image/png', size: 10 }),
  ])
  assert.equal(images[0].caption, '')
  assert.match(images[0].preview, /^blob:/)

  const formData = createBugReportFormData({
    type: 'bug',
    title: 'Title',
    description: 'Description',
    images,
  })
  assert.equal(formData.get('type'), 'bug')
  assert.equal(formData.get('title'), 'Title')
  assert.equal(formData.get('description'), 'Description')
  assert.equal(formData.get('caption_0'), 'Screenshot 1')
  assert.equal(formData.get('imageCount'), '1')
})
