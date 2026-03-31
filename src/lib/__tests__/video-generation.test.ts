import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLtxPayload,
  buildSceneVideoSettings,
  buildVeoRequestParts,
  getLtxConfig,
  getVeoVideoUri,
  pollVeoOperation,
} from '../video-generation.js'

type EnvPatch = Record<string, string | undefined>

async function withEnv(patch: EnvPatch, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('buildSceneVideoSettings applies Veo duration constraints from stored scene settings', () => {
  const constrained = buildSceneVideoSettings({
    id: 'scene-1',
    title: 'Launch shot',
    motion_prompt: 'Orbit around the product',
    generation_model: 'veo3',
    start_frame_image_id: null,
    end_frame_image_id: null,
    video_resolution: '1080p',
    video_aspect_ratio: '16:9',
    video_duration_seconds: 4,
    video_fps: 24,
    video_generate_audio: true,
  }, 'veo3')

  assert.equal(constrained.durationSeconds, 8)
  assert.equal(constrained.resolution, '1080p')
  assert.equal(constrained.generateAudio, true)
})

test('buildSceneVideoSettings preserves raw durations for LTX scenes', () => {
  const settings = buildSceneVideoSettings({
    id: 'scene-2',
    title: 'Closeup',
    motion_prompt: 'Slow pan',
    generation_model: 'ltx',
    start_frame_image_id: 'start-frame',
    end_frame_image_id: 'end-frame',
    video_resolution: '1920x1080',
    video_aspect_ratio: null,
    video_duration_seconds: 6,
    video_fps: 30,
    video_generate_audio: false,
  }, 'ltx')

  assert.equal(settings.durationSeconds, 6)
  assert.equal(settings.fps, 30)
  assert.equal(settings.generateAudio, false)
})

test('buildVeoRequestParts encodes frames, normalizes constrained durations, and honors audio gating', async () => {
  const originalFetch = global.fetch
  const frameBytes = new Uint8Array([1, 2, 3, 4]).buffer
  const fetchCalls: string[] = []
  try {
    global.fetch = async (input: string | URL | Request) => {
      fetchCalls.push(String(input))
      return new Response(frameBytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }

    await withEnv({ VEO_SUPPORTS_AUDIO: 'true' }, async () => {
      const { instance, parameters } = await buildVeoRequestParts(
        'Hero shot',
        {
          start: { url: 'https://example.com/start.png', mimeType: 'image/png' },
          end: { url: 'https://example.com/end.png', mimeType: 'image/png' },
        },
        {
          aspectRatio: '9:16',
          resolution: '720p',
          durationSeconds: 4,
          generateAudio: false,
        },
        'veo-3.1-generate-preview'
      )

      assert.deepEqual(fetchCalls, [
        'https://example.com/start.png',
        'https://example.com/end.png',
      ])
      assert.equal(instance.prompt, 'Hero shot')
      assert.equal((instance.image as { mimeType: string }).mimeType, 'image/png')
      assert.equal((instance.lastFrame as { bytesBase64Encoded: string }).bytesBase64Encoded, 'AQIDBA==')
      assert.deepEqual(parameters, {
        aspectRatio: '9:16',
        resolution: '720p',
        durationSeconds: 8,
        generateAudio: false,
      })
    })
  } finally {
    global.fetch = originalFetch
  }
})

test('buildVeoRequestParts rejects oversized frame payloads before encoding them', async () => {
  const originalFetch = global.fetch
  try {
    global.fetch = async () => new Response(Buffer.alloc(20 * 1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })

    await assert.rejects(
      () => buildVeoRequestParts(
        'Hero shot',
        {
          start: { url: 'https://example.com/start.png', mimeType: 'image/png' },
        },
        {
          resolution: '720p',
          durationSeconds: 8,
        },
        'veo-3.1-generate-preview'
      ),
      /Start frame exceeds 20971520 bytes/
    )
  } finally {
    global.fetch = originalFetch
  }
})

test('buildVeoRequestParts ignores an end frame without a start frame and skips unsupported audio flags', async () => {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  const warnings: string[] = []
  try {
    global.fetch = async () => {
      throw new Error('fetch should not be called without a start frame')
    }
    console.warn = (message?: unknown) => {
      warnings.push(String(message))
    }

    await withEnv({ VEO_SUPPORTS_AUDIO: 'false' }, async () => {
      const { instance, parameters } = await buildVeoRequestParts(
        'No start frame',
        {
          end: { url: 'https://example.com/end.png', mimeType: 'image/png' },
        },
        {
          resolution: '720p',
          durationSeconds: 5,
          generateAudio: true,
        },
        'veo-3.1-generate-preview'
      )

      assert.equal('lastFrame' in instance, false)
      assert.equal('generateAudio' in parameters, false)
      assert.equal(parameters.durationSeconds, 8)
      assert.deepEqual(warnings, ['[Veo] Ignoring end frame because no start frame was provided.'])
    })
  } finally {
    console.warn = originalWarn
    global.fetch = originalFetch
  }
})

test('pollVeoOperation waits for completion and rethrows API failures with the response body', async () => {
  const originalFetch = global.fetch
  const originalSetTimeout = global.setTimeout
  const responses = [
    createJsonResponse({ done: false }),
    createJsonResponse({
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri: 'https://example.com/video.mp4' } }],
        },
      },
    }),
  ]
  const sleepCalls: number[] = []
  try {
    global.fetch = async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected poll')
      return next
    }
    global.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      sleepCalls.push(delay ?? 0)
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    const operation = await pollVeoOperation(
      'https://veo.example.test',
      'operations/123',
      'api-key',
      250,
      5_000
    )

    assert.equal(operation.done, true)
    assert.deepEqual(sleepCalls, [250])

    global.fetch = async () => new Response('backend offline', { status: 503, statusText: 'Service Unavailable' })

    await assert.rejects(
      () => pollVeoOperation('https://veo.example.test', 'operations/123', 'api-key', 250, 5_000),
      /Veo operation error: 503 backend offline/
    )
  } finally {
    global.fetch = originalFetch
    global.setTimeout = originalSetTimeout
  }
})

test('pollVeoOperation aborts with a bounded timeout message', async () => {
  const originalFetch = global.fetch
  const originalNow = Date.now
  const nowValues = [0, 0, 1_500]
  try {
    global.fetch = async () => createJsonResponse({ done: false })
    Date.now = () => nowValues.shift() ?? 1_500

    await assert.rejects(
      () => pollVeoOperation('https://veo.example.test', 'operations/slow', 'api-key', 250, 1_000),
      /Veo generation timed out after 1s/
    )
  } finally {
    global.fetch = originalFetch
    Date.now = originalNow
  }
})

test('getVeoVideoUri surfaces operation errors and rejects malformed responses', () => {
  assert.throws(
    () => getVeoVideoUri({ error: { message: 'Permission denied' } }),
    /Veo operation error: Permission denied/
  )
  assert.throws(
    () => getVeoVideoUri({ done: true, response: {} }),
    /No video URI in Veo response/
  )
  assert.throws(
    () => getVeoVideoUri({
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri: 'http://example.com/video.mp4' } }],
        },
      },
    }),
    /Invalid video URI in Veo response/
  )
  assert.equal(
    getVeoVideoUri({
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri: 'https://example.com/video.mp4' } }],
        },
      },
    }),
    'https://example.com/video.mp4'
  )
})

test('getLtxConfig and buildLtxPayload preserve LTX-specific defaults and image-to-video shape', async () => {
  await withEnv(
    {
      LTX_API_KEY: 'ltx-secret',
      LTX_API_BASE_URL: 'https://ltx.example.test/',
      LTX_MODEL: 'ltx-2-pro',
      LTX_RESOLUTION: '2560x1440',
      LTX_DURATION: '10',
      LTX_REQUEST_TIMEOUT_MS: '45000',
    },
    () => {
      const config = getLtxConfig({
        resolution: null,
        durationSeconds: null,
        fps: 30,
        generateAudio: true,
      })
      const { endpoint, payload } = buildLtxPayload(
        'Product fly-through',
        { start: { url: 'https://example.com/start.png', mimeType: 'image/png' } },
        { fps: 30, generateAudio: true },
        config
      )

      assert.equal(config.baseUrl, 'https://ltx.example.test')
      assert.equal(config.durationSeconds, 10)
      assert.equal(config.requestTimeoutMs, 45000)
      assert.equal(endpoint, 'image-to-video')
      assert.deepEqual(payload, {
        prompt: 'Product fly-through',
        model: 'ltx-2-pro',
        duration: 10,
        resolution: '2560x1440',
        fps: 30,
        generate_audio: true,
        image_uri: 'https://example.com/start.png',
      })
    }
  )
})
