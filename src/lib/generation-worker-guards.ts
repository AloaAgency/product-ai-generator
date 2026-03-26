const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const MAX_GENERATION_BATCH_SIZE = 100
export const MAX_GENERATION_PARALLELISM = 16
export const MAX_GENERATION_JOB_BATCH_SIZE = 100
export const MAX_GENERATION_JOB_CONCURRENCY = 16
const MAX_ERROR_MESSAGE_LENGTH = 500

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

export function sanitizeWorkerErrorMessage(error: unknown, fallback = 'Worker error'): string {
  const rawMessage = (() => {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string') return error
    if (error == null) return ''
    return String(error)
  })()

  const normalized = rawMessage
    .replace(/\s+/g, ' ')
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|authorization|secret|signature|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .trim()

  if (!normalized) return fallback
  if (normalized.length <= MAX_ERROR_MESSAGE_LENGTH) return normalized
  return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
}
