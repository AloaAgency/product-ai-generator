import { describe, expect, it } from 'vitest'
import type { GenerationJob } from '../lib/types'
import {
  deriveGenerationQueueState,
  getFailureTimestamp,
  getGenerationJobProgress,
  getGenerationJobUnitLabel,
  getGenerationQueueOutputLabel,
  getGenerationQueueSummary,
  isActiveStatus,
  POLL_MS,
  shouldPollGenerationQueue,
  shouldShowIndeterminateJobProgress,
} from './globalGenerationQueue.helpers'

// The matching node:test suite under src/components/__tests__/ is excluded from
// vitest (see vitest.config.ts), so these vitest specs are what actually guard
// the queue logic in `npm test`. They focus on the branches that suite skips:
// summary/label permutations, failure ordering tie-breaks, and poll gating.

const buildJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: 'job-1',
  product_id: 'product-1',
  prompt_template_id: null,
  final_prompt: 'Prompt',
  variation_count: 1,
  resolution: '1024',
  aspect_ratio: '1:1',
  status: 'pending',
  completed_count: 0,
  failed_count: 0,
  error_message: null,
  generation_model: 'gemini',
  job_type: 'image',
  scene_id: null,
  source_image_id: null,
  created_at: '2024-01-01T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  ...overrides,
})

describe('globalGenerationQueue.helpers — status classification', () => {
  it('treats only pending and running jobs as active', () => {
    expect(isActiveStatus('pending')).toBe(true)
    expect(isActiveStatus('running')).toBe(true)
    expect(isActiveStatus('completed')).toBe(false)
    expect(isActiveStatus('failed')).toBe(false)
    expect(isActiveStatus('')).toBe(false)
  })
})

describe('globalGenerationQueue.helpers — failure ordering', () => {
  it('falls back to created_at when completed_at is missing so unfinished failures still sort', () => {
    const state = deriveGenerationQueueState([
      buildJob({ id: 'older', status: 'failed', completed_at: null, created_at: '2024-03-01T00:00:00.000Z' }),
      buildJob({ id: 'newer', status: 'failed', completed_at: null, created_at: '2024-03-05T00:00:00.000Z' }),
    ])

    expect(state.recentFailedJobs.map((job) => job.id)).toEqual(['newer', 'older'])
  })

  it('drops a fourth failure that is older than every retained failure instead of growing the list', () => {
    const state = deriveGenerationQueueState([
      buildJob({ id: 'f1', status: 'failed', completed_at: '2024-03-04T00:00:00.000Z' }),
      buildJob({ id: 'f2', status: 'failed', completed_at: '2024-03-03T00:00:00.000Z' }),
      buildJob({ id: 'f3', status: 'failed', completed_at: '2024-03-02T00:00:00.000Z' }),
      buildJob({ id: 'oldest', status: 'failed', completed_at: '2024-03-01T00:00:00.000Z' }),
    ])

    expect(state.failedCount).toBe(4)
    expect(state.recentFailedJobs).toHaveLength(3)
    expect(state.recentFailedJobs.map((job) => job.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('evicts the oldest retained failure when a newer one arrives later in the list', () => {
    const state = deriveGenerationQueueState([
      buildJob({ id: 'f1', status: 'failed', completed_at: '2024-03-01T00:00:00.000Z' }),
      buildJob({ id: 'f2', status: 'failed', completed_at: '2024-03-02T00:00:00.000Z' }),
      buildJob({ id: 'f3', status: 'failed', completed_at: '2024-03-03T00:00:00.000Z' }),
      buildJob({ id: 'newest', status: 'failed', completed_at: '2024-03-04T00:00:00.000Z' }),
    ])

    expect(state.recentFailedJobs.map((job) => job.id)).toEqual(['newest', 'f3', 'f2'])
  })

  it('ignores completed and cancelled jobs entirely', () => {
    const state = deriveGenerationQueueState([
      buildJob({ id: 'done', status: 'completed', variation_count: 4, completed_count: 4 }),
      buildJob({ id: 'cancelled', status: 'cancelled', variation_count: 2, completed_count: 1 }),
    ])

    expect(state.activeJobs).toEqual([])
    expect(state.failedCount).toBe(0)
    expect(state.totals).toEqual({ totalVariations: 0, totalCompleted: 0 })
    expect(state.overallProgress).toBe(0)
    expect(state.hasActiveJobs).toBe(false)
  })
})

describe('globalGenerationQueue.helpers — summary and labels', () => {
  it('omits the failed suffix when active jobs have no failures', () => {
    expect(
      getGenerationQueueSummary({
        loadingJobs: false,
        generationJobCount: 1,
        hasActiveJobs: true,
        pendingCount: 2,
        runningCount: 0,
        failedCount: 0,
      })
    ).toBe('2 pending · 0 running')
  })

  it('reports failures-only state when nothing is active', () => {
    expect(
      getGenerationQueueSummary({
        loadingJobs: false,
        generationJobCount: 3,
        hasActiveJobs: false,
        pendingCount: 0,
        runningCount: 0,
        failedCount: 2,
      })
    ).toBe('No active generations · 2 failed recently')
  })

  it('reports a fully idle queue', () => {
    expect(
      getGenerationQueueSummary({
        loadingJobs: false,
        generationJobCount: 0,
        hasActiveJobs: false,
        pendingCount: 0,
        runningCount: 0,
        failedCount: 0,
      })
    ).toBe('No active generations')
  })

  it('keeps showing prior counts while refreshing an already-populated queue', () => {
    // loadingJobs is true but jobs already exist -> do NOT flip back to "Checking queue..."
    expect(
      getGenerationQueueSummary({
        loadingJobs: true,
        generationJobCount: 2,
        hasActiveJobs: true,
        pendingCount: 1,
        runningCount: 1,
        failedCount: 0,
      })
    ).toBe('1 pending · 1 running')
  })

  it('falls back to "0 outputs" when the queue is idle and nothing failed', () => {
    expect(
      getGenerationQueueOutputLabel({
        hasActiveJobs: false,
        failedCount: 0,
        totals: { totalCompleted: 0, totalVariations: 0 },
      })
    ).toBe('0 outputs')
  })

  it('pluralizes unit labels by job type and variation count', () => {
    expect(getGenerationJobUnitLabel(buildJob({ job_type: 'image', variation_count: 1 }))).toBe('image')
    expect(getGenerationJobUnitLabel(buildJob({ job_type: 'video', variation_count: 3 }))).toBe('videos')
  })
})

describe('globalGenerationQueue.helpers — progress and polling', () => {
  it('rounds partial progress to the nearest whole percent', () => {
    expect(getGenerationJobProgress({ completed_count: 1, variation_count: 3 })).toBe(33)
    expect(getGenerationJobProgress({ completed_count: 2, variation_count: 3 })).toBe(67)
  })

  it('shows indeterminate progress only before a running job reports output', () => {
    expect(shouldShowIndeterminateJobProgress({ status: 'pending', completed_count: 5 })).toBe(true)
    expect(shouldShowIndeterminateJobProgress({ status: 'running', completed_count: 0 })).toBe(true)
    expect(shouldShowIndeterminateJobProgress({ status: 'running', completed_count: 2 })).toBe(false)
    expect(shouldShowIndeterminateJobProgress({ status: 'completed', completed_count: 0 })).toBe(false)
  })

  it('honors a custom minimum poll interval and defaults to POLL_MS', () => {
    expect(
      shouldPollGenerationQueue({
        hasActiveJobs: true,
        isDocumentVisible: true,
        isPolling: false,
        timeSinceLastPollMs: 1500,
        minIntervalMs: 1000,
      })
    ).toBe(true)
    expect(
      shouldPollGenerationQueue({
        hasActiveJobs: true,
        isDocumentVisible: true,
        isPolling: false,
        timeSinceLastPollMs: POLL_MS,
      })
    ).toBe(true)
    expect(
      shouldPollGenerationQueue({
        hasActiveJobs: true,
        isDocumentVisible: true,
        isPolling: false,
        timeSinceLastPollMs: POLL_MS - 1,
      })
    ).toBe(false)
  })

  it('returns null for unparseable failure timestamps and a string otherwise', () => {
    expect(getFailureTimestamp(null)).toBe(null)
    expect(getFailureTimestamp('')).toBe(null)
    expect(getFailureTimestamp('garbage')).toBe(null)
    expect(typeof getFailureTimestamp('2024-03-02T12:00:00.000Z')).toBe('string')
  })
})
