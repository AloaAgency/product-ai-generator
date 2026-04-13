import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  buildLtxPayload,
  buildSceneVideoSettings,
  buildVeoRequestParts,
  getLtxConfig,
  getVeoVideoUri,
  pollVeoOperation,
} from '../video-generation'

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('buildSceneVideoSettings', () => {
  it('applies Veo duration constraints from stored scene settings', () => {
    const constrained = buildSceneVideoSettings({
      id: 'scene-1',
      product_id: 'product-1',
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

    expect(constrained.durationSeconds).toBe(8)
    expect(constrained.resolution).toBe('1080p')
    expect(constrained.generateAudio).toBe(true)
  })

  it('preserves raw durations for LTX scenes', () => {
    const settings = buildSceneVideoSettings({
      id: 'scene-2',
      product_id: 'product-1',
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

    expect(settings.durationSeconds).toBe(6)
    expect(settings.fps).toBe(30)
    expect(settings.generateAudio).toBe(false)
  })
})

describe('buildVeoRequestParts', () => {
  it('encodes frames, normalizes constrained durations, and honors audio gating', async () => {
    const frameBytes = new Uint8Array([1, 2, 3, 4]).buffer
    const fetchCalls: string[] = []
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      fetchCalls.push(String(input))
      return new Response(frameBytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    })

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

      expect(fetchCalls).toStrictEqual([
        'https://example.com/start.png',
        'https://example.com/end.png',
      ])
      expect(instance.prompt).toBe('Hero shot')
      expect((instance.image as { mimeType: string }).mimeType).toBe('image/png')
      expect((instance.lastFrame as { bytesBase64Encoded: string }).bytesBase64Encoded).toBe('AQIDBA==')
      expect(parameters).toStrictEqual({
        aspectRatio: '9:16',
        resolution: '720p',
        durationSeconds: 8,
        generateAudio: false,
      })
    })
  })

  it('rejects oversized frame payloads before encoding them', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.alloc(20 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    )

    await expect(
      buildVeoRequestParts(
        'Hero shot',
        { start: { url: 'https://example.com/start.png', mimeType: 'image/png' } },
        { resolution: '720p', durationSeconds: 8 },
        'veo-3.1-generate-preview'
      )
    ).rejects.toThrow(/Start frame exceeds 20971520 bytes/)
  })

  it('ignores an end frame without a start frame and skips unsupported audio flags', async () => {
    const warnings: string[] = []
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called without a start frame')
    })
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warnings.push(String(message))
    })

    await withEnv({ VEO_SUPPORTS_AUDIO: 'false' }, async () => {
      const { instance, parameters } = await buildVeoRequestParts(
        'No start frame',
        { end: { url: 'https://example.com/end.png', mimeType: 'image/png' } },
        { resolution: '720p', durationSeconds: 5, generateAudio: true },
        'veo-3.1-generate-preview'
      )

      expect('lastFrame' in instance).toBe(false)
      expect('generateAudio' in parameters).toBe(false)
      expect(parameters.durationSeconds).toBe(8)
      expect(warnings).toStrictEqual(['[Veo] Ignoring end frame because no start frame was provided.'])
    })
  })
})

describe('pollVeoOperation', () => {
  it('waits for completion and rethrows API failures with the response body', async () => {
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
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected poll')
      return next
    })
    // Make all setTimeout calls resolve immediately so the test does not wait
    // for the poll interval or the per-request abort timer.
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void
    ) => {
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    const operation = await pollVeoOperation(
      'https://veo.example.test',
      'operations/123',
      'api-key',
      250,
      5_000
    )

    expect(operation.done).toBe(true)

    // Verify the error path: function should exhaust retries and throw.
    // Use mockImplementation (not mockResolvedValue) so each retry gets a fresh
    // Response whose body hasn't been consumed by a previous attempt.
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response('backend offline', { status: 503, statusText: 'Service Unavailable' })
    )

    await expect(
      pollVeoOperation('https://veo.example.test', 'operations/123', 'api-key', 250, 5_000)
    ).rejects.toThrow(/Veo operation error \(503\): backend offline/)
  })

  it('retries transient polling failures before succeeding', async () => {
    const sleepDelays: number[] = []
    const responses = [
      new Response('backend offline', { status: 503, statusText: 'Service Unavailable' }),
      createJsonResponse({ done: true, response: {} }),
    ]

    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected poll')
      return next
    })
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number
    ) => {
      sleepDelays.push(delay ?? 0)
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    const operation = await pollVeoOperation(
      'https://veo.example.test',
      'operations/retry',
      'api-key',
      250,
      5_000
    )

    expect(operation.done).toBe(true)
    // The retry back-off delay should appear (1000ms base for first retry)
    expect(sleepDelays).toContain(1000)
  })

  it('redacts sensitive response details in surfaced errors', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response('token=secret-value api_key: abc123', { status: 500, statusText: 'Server Error' })
    )
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void
    ) => {
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    await expect(
      pollVeoOperation('https://veo.example.test', 'operations/123', 'api-key', 250, 5_000)
    ).rejects.toThrow(/token=\[redacted\] api_key: \[redacted\]/)
  })

  it('aborts with a bounded timeout message', async () => {
    const nowValues = [0, 0, 1_500]
    vi.spyOn(global, 'fetch').mockImplementation(async () => createJsonResponse({ done: false }))
    vi.spyOn(Date, 'now').mockImplementation(() => nowValues.shift() ?? 1_500)

    await expect(
      pollVeoOperation('https://veo.example.test', 'operations/slow', 'api-key', 250, 1_000)
    ).rejects.toThrow(/Veo generation timed out after 1s/)
  })
})

describe('getVeoVideoUri', () => {
  it('surfaces operation errors and rejects malformed responses', () => {
    expect(() => getVeoVideoUri({ error: { message: 'Permission denied' } })).toThrow(
      /Veo operation error: Permission denied/
    )
    expect(() => getVeoVideoUri({ done: true, response: {} })).toThrow(
      /No video URI in Veo response/
    )
    expect(() =>
      getVeoVideoUri({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'http://example.com/video.mp4' } }],
          },
        },
      })
    ).toThrow(/Invalid video URI in Veo response/)
    expect(
      getVeoVideoUri({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'https://example.com/video.mp4' } }],
          },
        },
      })
    ).toBe('https://example.com/video.mp4')
  })
})

describe('getLtxConfig and buildLtxPayload', () => {
  it('preserves LTX-specific defaults and image-to-video shape', async () => {
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

        expect(config.baseUrl).toBe('https://ltx.example.test')
        expect(config.durationSeconds).toBe(10)
        expect(config.requestTimeoutMs).toBe(45000)
        expect(endpoint).toBe('image-to-video')
        expect(payload).toStrictEqual({
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
})
