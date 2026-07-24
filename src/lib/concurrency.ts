/**
 * Order-preserving parallel map with a concurrency cap.
 *
 * Runs `fn` over `items` with at most `limit` invocations in flight, returning
 * results in the same order as the input. Used by batch image routes to
 * overlap download → Sharp → upload pipelines without unbounded memory growth.
 *
 * Rejections propagate: if any invocation throws, the returned promise rejects
 * (in-flight work still settles, no new work starts). Callers that need
 * per-item error reporting should catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()))
  return results
}
