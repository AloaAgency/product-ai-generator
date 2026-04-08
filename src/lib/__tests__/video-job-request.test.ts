import { describe, it, expect, vi, afterEach } from 'vitest'

import { buildVideoJobRequest, kickWorkerForJob, shouldRunVideoGenerationInline } from '../video-job-request'

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildVideoJobRequest', () => {
  it('keeps scene overrides and explicit model selections', () => {
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

    expect(request).toStrictEqual({
      model: 'ltx',
      resolution: '4k',
      aspectRatio: '9:16',
      finalPrompt: 'Track the bottle through splashing water',
    })
  })

  it('falls back to provider-specific defaults when scene settings are empty', () => {
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

    expect(veoRequest).toStrictEqual({
      model: 'veo3',
      resolution: '720p',
      aspectRatio: '16:9',
      finalPrompt: 'Scene title',
    })
    expect(ltxRequest).toStrictEqual({
      model: 'ltx-2',
      resolution: '2560x1440',
      aspectRatio: '16:9',
      finalPrompt: 'Video generation',
    })
  })
})

describe('shouldRunVideoGenerationInline', () => {
  it('only enables inline execution for local or explicitly opted-in environments', () => {
    expect(shouldRunVideoGenerationInline(env({ NODE_ENV: 'development' }))).toBe(true)
    expect(shouldRunVideoGenerationInline(env({ INLINE_GENERATION: 'true', NODE_ENV: 'production' }))).toBe(true)
    expect(shouldRunVideoGenerationInline(env({ INLINE_GENERATION: 'false', NODE_ENV: 'production' }))).toBe(false)
    expect(shouldRunVideoGenerationInline(env({}))).toBe(false)
  })
})

describe('kickWorkerForJob', () => {
  it('issues an authenticated worker request', async () => {
    const logs: Array<{ message: string; payload: unknown }> = []
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown, payload?: unknown) => {
      logs.push({ message: String(message), payload })
    })

    kickWorkerForJob(
      'job-1',
      'https://example.test/products/123',
      '[GenerateVideo]',
      { jobs: '2' },
      env({ CRON_SECRET: 'secret', WORKER_KICK_TIMEOUT_MS: '5000' })
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    const call = fetchSpy.mock.calls[0]
    expect(String(call?.[0])).toBe('https://example.test/api/worker/generate?jobId=job-1&jobs=2')
    expect((call?.[1]?.headers as Record<string, string>)?.Authorization).toBe('Bearer secret')
    expect(logs).toStrictEqual([
      { message: '[GenerateVideo] Worker kick', payload: { jobId: 'job-1', status: 202 } },
    ])

    logSpy.mockRestore()
  })

  it('swallows abort errors from fire-and-forget worker kicks', async () => {
    const warnings: Array<{ message: string; payload: unknown }> = []
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown, payload?: unknown) => {
      warnings.push({ message: String(message), payload })
    })
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void) => {
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    kickWorkerForJob(
      'job-2',
      'https://example.test/products/123',
      '[GenerateVideo]',
      undefined,
      env({ CRON_SECRET: 'secret', WORKER_KICK_TIMEOUT_MS: '1' })
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toBe('[GenerateVideo] Worker kick failed')
    expect(String((warnings[0]?.payload as { error?: string }).error)).toMatch(/aborted/i)
  })
})
