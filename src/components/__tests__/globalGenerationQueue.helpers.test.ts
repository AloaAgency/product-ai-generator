import test from 'node:test'
import assert from 'node:assert/strict'
import type { GenerationJob } from '../../lib/types'
import {
  deriveGenerationQueueState,
  getFailureTimestamp,
  getGenerationJobProgress,
} from '../globalGenerationQueue.helpers.js'

const buildJob = (overrides: Partial<GenerationJob>): GenerationJob => ({
  id: 'job-1',
  product_id: 'product-1',
  prompt_template_id: null,
  reference_set_id: null,
  texture_set_id: null,
  product_image_count: null,
  texture_image_count: null,
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

test('deriveGenerationQueueState summarizes active and failed jobs without counting completed work twice', () => {
  const state = deriveGenerationQueueState([
    buildJob({ id: 'pending', status: 'pending', variation_count: 3, completed_count: 1 }),
    buildJob({ id: 'running', status: 'running', variation_count: 2, completed_count: 2 }),
    buildJob({ id: 'completed', status: 'completed', variation_count: 10, completed_count: 10 }),
    buildJob({
      id: 'failed-new',
      status: 'failed',
      completed_at: '2024-03-02T12:00:00.000Z',
      created_at: '2024-03-01T12:00:00.000Z',
    }),
    buildJob({
      id: 'failed-invalid',
      status: 'failed',
      completed_at: 'not-a-date',
      created_at: 'also-not-a-date',
    }),
  ])

  assert.equal(state.pendingCount, 1)
  assert.equal(state.runningCount, 1)
  assert.equal(state.failedCount, 2)
  assert.deepEqual(state.activeJobs.map((job) => job.id), ['pending', 'running'])
  assert.deepEqual(state.recentFailedJobs.map((job) => job.id), ['failed-new', 'failed-invalid'])
  assert.deepEqual(state.totals, { totalVariations: 5, totalCompleted: 3 })
  assert.equal(state.overallProgress, 60)
  assert.equal(state.hasActiveJobs, true)
})

test('deriveGenerationQueueState keeps only the three newest failures without sorting the full history', () => {
  const state = deriveGenerationQueueState([
    buildJob({ id: 'failed-1', status: 'failed', completed_at: '2024-03-01T12:00:00.000Z' }),
    buildJob({ id: 'failed-3', status: 'failed', completed_at: '2024-03-03T12:00:00.000Z' }),
    buildJob({ id: 'failed-2', status: 'failed', completed_at: '2024-03-02T12:00:00.000Z' }),
    buildJob({ id: 'failed-4', status: 'failed', completed_at: '2024-03-04T12:00:00.000Z' }),
  ])

  assert.equal(state.failedCount, 4)
  assert.deepEqual(state.recentFailedJobs.map((job) => job.id), ['failed-4', 'failed-3', 'failed-2'])
})

test('getGenerationJobProgress clamps invalid and over-complete jobs into a safe percentage range', () => {
  assert.equal(getGenerationJobProgress({ completed_count: 0, variation_count: 0 }), 0)
  assert.equal(getGenerationJobProgress({ completed_count: -1, variation_count: 4 }), 0)
  assert.equal(getGenerationJobProgress({ completed_count: 7, variation_count: 4 }), 100)
})

test('getFailureTimestamp returns null for invalid timestamps', () => {
  assert.equal(getFailureTimestamp('not-a-date'), null)
  assert.equal(getFailureTimestamp(undefined), null)
  assert.match(getFailureTimestamp('2024-03-02T12:00:00.000Z') || '', /\d{4}|\d{1,2}/)
})
