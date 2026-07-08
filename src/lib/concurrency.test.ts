import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './concurrency'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Earlier items finish later — order must still match the input.
    const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms) => {
      await delay(ms)
      return ms
    })
    expect(results).toEqual([30, 20, 10, 0])
  })

  it('passes the item index to the callback', async () => {
    const results = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => `${item}${index}`)
    expect(results).toEqual(['a0', 'b1', 'c2'])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
    })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('processes every item exactly once', async () => {
    const seen: number[] = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item)
      await delay(1)
    })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('returns an empty array for empty input', async () => {
    const results = await mapWithConcurrency([], 3, async () => 1)
    expect(results).toEqual([])
  })

  it('rejects when a callback throws', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      })
    ).rejects.toThrow('boom')
  })

  it('treats a non-positive or non-finite limit as 1 (serial)', async () => {
    let active = 0
    let maxActive = 0
    const run = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(2)
      active -= 1
    }
    await mapWithConcurrency([1, 2, 3], 0, run)
    await mapWithConcurrency([1, 2, 3], Number.NaN, run)
    expect(maxActive).toBe(1)
  })

  it('caps workers at the item count when limit exceeds it', async () => {
    const results = await mapWithConcurrency([1, 2], 50, async (n) => n * 2)
    expect(results).toEqual([2, 4])
  })
})
