/**
 * Client-safe leveled logger.
 *
 * Server modules should import `@/lib/server-logger` so LOG_LEVEL remains a
 * server-only setting. Every argument is sanitized here before it reaches a
 * console sink, regardless of whether the caller runs in a browser or Node.
 */

import { isClientDevelopmentRuntime } from '@/lib/client-runtime'
import { redactSensitiveText } from '@/lib/redact-secrets'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

type ThresholdResolver = () => LogLevel

const resolveClientThreshold: ThresholdResolver = () =>
  isClientDevelopmentRuntime() ? 'debug' : 'warn'

const SENSITIVE_LOG_KEYS = new Set([
  'apikey',
  'authorization',
  'body',
  'cookie',
  'credentials',
  'headers',
  'password',
  'privatekey',
  'req',
  'request',
  'secret',
  'servicekey',
  'servicerolekey',
  'setcookie',
  'signature',
  'token',
])

const MAX_LOG_SANITIZE_DEPTH = 6

function normalizeLogKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isSensitiveLogKey(key: string) {
  const normalized = normalizeLogKey(key)
  return SENSITIVE_LOG_KEYS.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
}

function sanitizeLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_LOG_SANITIZE_DEPTH) return '[truncated]'

  seen.add(value)
  try {
    if (value instanceof Error) {
      return {
        name: redactSensitiveText(value.name),
        message: redactSensitiveText(value.message),
        ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
      }
    }

    if (value instanceof URL) return redactSensitiveText(value.toString())
    if (value instanceof Date) return value.toISOString()
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary data]'
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeLogValue(item, seen, depth + 1))
    }

    const constructorName = value.constructor?.name
    if (constructorName === 'Headers' || constructorName === 'Request' || constructorName === 'Response') {
      return `[redacted ${constructorName}]`
    }

    const safe: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      safe[key] = isSensitiveLogKey(key)
        ? '[redacted]'
        : sanitizeLogValue(item, seen, depth + 1)
    }
    return safe
  } finally {
    seen.delete(value)
  }
}

/** Sanitize arbitrary console arguments without mutating caller-owned values. */
export function sanitizeLogArgument(value: unknown): unknown {
  return sanitizeLogValue(value, new WeakSet<object>(), 0)
}

function sanitizeLogArguments(args: unknown[]) {
  return args.map((arg) => sanitizeLogArgument(arg))
}

function shouldLog(
  level: Exclude<LogLevel, 'silent'>,
  resolveThreshold: ThresholdResolver
) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[resolveThreshold()]
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLoggerWithThreshold(
  scope: string,
  resolveThreshold: ThresholdResolver
): Logger {
  const prefix = `[${scope}]`
  return {
    debug: (...args) => {
      if (shouldLog('debug', resolveThreshold)) console.debug(prefix, ...sanitizeLogArguments(args))
    },
    info: (...args) => {
      if (shouldLog('info', resolveThreshold)) console.info(prefix, ...sanitizeLogArguments(args))
    },
    warn: (...args) => {
      if (shouldLog('warn', resolveThreshold)) console.warn(prefix, ...sanitizeLogArguments(args))
    },
    error: (...args) => {
      if (shouldLog('error', resolveThreshold)) console.error(prefix, ...sanitizeLogArguments(args))
    },
  }
}

export function createUnscopedLoggerWithThreshold(
  resolveThreshold: ThresholdResolver
): Logger {
  return {
    debug: (...args) => {
      if (shouldLog('debug', resolveThreshold)) console.debug(...sanitizeLogArguments(args))
    },
    info: (...args) => {
      if (shouldLog('info', resolveThreshold)) console.info(...sanitizeLogArguments(args))
    },
    warn: (...args) => {
      if (shouldLog('warn', resolveThreshold)) console.warn(...sanitizeLogArguments(args))
    },
    error: (...args) => {
      if (shouldLog('error', resolveThreshold)) console.error(...sanitizeLogArguments(args))
    },
  }
}

export function createLogger(scope: string): Logger {
  return createLoggerWithThreshold(scope, resolveClientThreshold)
}

/** Unscoped logger for client-safe/shared modules. */
export const logger = createUnscopedLoggerWithThreshold(resolveClientThreshold)
