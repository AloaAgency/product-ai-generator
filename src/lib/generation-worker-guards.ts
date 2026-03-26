const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const MAX_GENERATION_BATCH_SIZE = 100
export const MAX_GENERATION_PARALLELISM = 16
export const MAX_GENERATION_JOB_BATCH_SIZE = 100
export const MAX_GENERATION_JOB_CONCURRENCY = 16

type PositiveIntegerOptions = {
  min?: number
  max?: number
}

export function isValidGenerationJobId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function parseWorkerPositiveInteger(
  value: string | number | null | undefined,
  fallback: number,
  options: PositiveIntegerOptions = {}
): number {
  const min = options.min ?? 1
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  const parsed = typeof value === 'number' ? value : Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return fallback
  }

  return Math.min(parsed, max)
}
