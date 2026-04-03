const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again or contact support if the issue persists.'
const GENERIC_QUEUE_ERROR_MESSAGE = 'Generation failed. Try again or review your prompt and settings.'
const GENERIC_DOWNLOAD_ERROR_MESSAGE = 'Download failed. Please try again.'
const MAX_ERROR_MESSAGE_LENGTH = 240
const MAX_ERROR_CONTEXT_LENGTH = 1200

const INTERNAL_ERROR_PATTERNS = [
  /<[^>]+>/,
  /\b(?:select|insert|update|delete|from|where)\b.+\b(?:limit|returning|group by|order by)\b/i,
  /\b(?:exception|traceback|stack trace|sqlstate|supabase|postgres|prisma|node_modules)\b/i,
  /\b(?:api[_ -]?key|authorization|bearer|token|secret|password|cookie|set-cookie)\b/i,
  /\b(?:https?:\/\/|s3:\/\/|gs:\/\/)[^\s]+/i,
]

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const stripStackTrace = (value: string) => value.split(/\n\s*at\s+/)[0] ?? value

const isInternalErrorMessage = (value: string) =>
  INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(value))

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value

export const getSafeErrorMessage = (
  raw: string | null | undefined,
  fallback = GENERIC_ERROR_MESSAGE
) => {
  if (!raw) return fallback
  if (/\n\s*at\s+/.test(raw)) return fallback

  const normalized = normalizeWhitespace(stripStackTrace(raw))
  if (!normalized || isInternalErrorMessage(normalized)) {
    return fallback
  }

  return truncate(normalized, MAX_ERROR_MESSAGE_LENGTH)
}

export const getSafeQueueErrorMessage = (raw: string | null | undefined) =>
  getSafeErrorMessage(raw, GENERIC_QUEUE_ERROR_MESSAGE)

export const getSafeDownloadErrorMessage = (raw: string | null | undefined) =>
  getSafeErrorMessage(raw, GENERIC_DOWNLOAD_ERROR_MESSAGE)

export const getSafeErrorContext = (context: Record<string, unknown> | null | undefined) => {
  if (!context) return null

  try {
    const sanitized = JSON.stringify(
      context,
      (key, value) => {
        if (typeof value !== 'string') return value
        if (/(api[_ -]?key|authorization|bearer|token|secret|password|cookie)/i.test(key)) {
          return '[redacted]'
        }
        if (/(api[_ -]?key|authorization|bearer|token|secret|password|cookie)/i.test(value)) {
          return '[redacted]'
        }
        return value
      },
      2
    )

    return truncate(sanitized, MAX_ERROR_CONTEXT_LENGTH)
  } catch {
    return null
  }
}
