import test from 'node:test'
import assert from 'node:assert/strict'

import { buildVideoJobRequest, kickWorkerForJob, shouldRunVideoGenerationInline } from '../video-job-request.js'

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

test('kickWorkerForJob issues an authenticated worker request', async () => {
  const originalFetch = global.fetch
  const originalLog = console.log
  const logs: Array<{ message: string; payload: unknown }> = []

  try {
    global.fetch = async (input, init) => {
      assert.equal(String(input), 'https://example.test/api/worker/generate?jobId=job-1&jobs=2')
      assert.equal(init?.method, 'GET')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret')
      return new Response(null, { status: 202 })
    }
    console.log = (message?: unknown, payload?: unknown) => {
      logs.push({ message: String(message), payload })
    }

    kickWorkerForJob(
      'job-1',
      'https://example.test/products/123',
      '[GenerateVideo]',
      { jobs: '2' },
      env({ CRON_SECRET: 'secret', WORKER_KICK_TIMEOUT_MS: '5000' })
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(logs, [
      { message: '[GenerateVideo] Worker kick', payload: { jobId: 'job-1', status: 202 } },
    ])
  } finally {
    global.fetch = originalFetch
    console.log = originalLog
  }
})

test('kickWorkerForJob swallows abort errors from fire-and-forget worker kicks', async () => {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  const originalSetTimeout = global.setTimeout
  const warnings: Array<{ message: string; payload: unknown }> = []

  try {
    global.fetch = async (_input, init) => {
      assert.equal(init?.signal?.aborted, true)
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    console.warn = (message?: unknown, payload?: unknown) => {
      warnings.push({ message: String(message), payload })
    }
    global.setTimeout = ((callback: (...args: unknown[]) => void) => {
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    kickWorkerForJob(
      'job-2',
      'https://example.test/products/123',
      '[GenerateVideo]',
      undefined,
      env({ CRON_SECRET: 'secret', WORKER_KICK_TIMEOUT_MS: '1' })
    )

    await Promise.resolve()
    await Promise.resolve()

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.message, '[GenerateVideo] Worker kick failed')
    assert.match(String((warnings[0]?.payload as { error?: string }).error), /aborted/i)
  } finally {
    global.fetch = originalFetch
    console.warn = originalWarn
    global.setTimeout = originalSetTimeout
  }
})
