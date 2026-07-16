/**
 * Client-safe leveled logger.
 *
 * Server modules should import `@/lib/server-logger` so LOG_LEVEL remains a
 * server-only setting. Client modules derive their diagnostic level from the
 * non-sensitive runtime classification rendered by the root layout.
 */

import { isClientDevelopmentRuntime } from '@/lib/client-runtime'

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
      if (shouldLog('debug', resolveThreshold)) console.debug(prefix, ...args)
    },
    info: (...args) => {
      if (shouldLog('info', resolveThreshold)) console.info(prefix, ...args)
    },
    warn: (...args) => {
      if (shouldLog('warn', resolveThreshold)) console.warn(prefix, ...args)
    },
    error: (...args) => {
      if (shouldLog('error', resolveThreshold)) console.error(prefix, ...args)
    },
  }
}

export function createUnscopedLoggerWithThreshold(
  resolveThreshold: ThresholdResolver
): Logger {
  return {
    debug: (...args) => {
      if (shouldLog('debug', resolveThreshold)) console.debug(...args)
    },
    info: (...args) => {
      if (shouldLog('info', resolveThreshold)) console.info(...args)
    },
    warn: (...args) => {
      if (shouldLog('warn', resolveThreshold)) console.warn(...args)
    },
    error: (...args) => {
      if (shouldLog('error', resolveThreshold)) console.error(...args)
    },
  }
}

export function createLogger(scope: string): Logger {
  return createLoggerWithThreshold(scope, resolveClientThreshold)
}

/** Unscoped logger for client-safe/shared modules. */
export const logger = createUnscopedLoggerWithThreshold(resolveClientThreshold)
