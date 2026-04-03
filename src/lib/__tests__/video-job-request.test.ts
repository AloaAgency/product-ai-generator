import test from 'node:test'
import assert from 'node:assert/strict'

import { buildVideoJobRequest, shouldRunVideoGenerationInline } from '../video-job-request.js'

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv

test('buildVideoJobRequest keeps scene overrides and explicit model selections', () => {
  const request = buildVideoJobRequest(
    {
      motion_prompt: 'Track the bottle through splashing water',
      title: 'Bottle splash',
      generation_model: 'veo3',
      video_resolution: '4k',
      video_aspect_ratio: '9:16',
    },
    'ltx'
  )

  assert.deepEqual(request, {
    model: 'ltx',
    resolution: '4k',
    aspectRatio: '9:16',
    finalPrompt: 'Track the bottle through splashing water',
  })
})

test('buildVideoJobRequest falls back to provider-specific defaults when scene settings are empty', () => {
  const veoRequest = buildVideoJobRequest(
    {
      motion_prompt: null,
      title: 'Scene title',
      generation_model: null,
      video_resolution: null,
      video_aspect_ratio: null,
    },
    null,
    env({ VEO_RESOLUTION: '720p', VEO_ASPECT_RATIO: '16:9' })
  )
  const ltxRequest = buildVideoJobRequest(
    {
      motion_prompt: null,
      title: null,
      generation_model: null,
      video_resolution: null,
      video_aspect_ratio: null,
    },
    'ltx-2',
    env({ LTX_RESOLUTION: '2560x1440' })
  )

  assert.deepEqual(veoRequest, {
    model: 'veo3',
    resolution: '720p',
    aspectRatio: '16:9',
    finalPrompt: 'Scene title',
  })
  assert.deepEqual(ltxRequest, {
    model: 'ltx-2',
    resolution: '2560x1440',
    aspectRatio: '16:9',
    finalPrompt: 'Video generation',
  })
})

test('shouldRunVideoGenerationInline only enables inline execution for local or explicitly opted-in environments', () => {
  assert.equal(shouldRunVideoGenerationInline(env({ NODE_ENV: 'development' })), true)
  assert.equal(shouldRunVideoGenerationInline(env({ INLINE_GENERATION: 'true', NODE_ENV: 'production' })), true)
  assert.equal(shouldRunVideoGenerationInline(env({ INLINE_GENERATION: 'false', NODE_ENV: 'production' })), false)
  assert.equal(shouldRunVideoGenerationInline(env({})), false)
})
