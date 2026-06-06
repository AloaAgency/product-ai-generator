/**
 * Lightweight leveled logger.
 *
 * Goals:
 * - Keep the existing `[Tag] message` console convention via scoped loggers.
 * - Silence `debug`/`info` noise in production while always surfacing
 *   `warn`/`error`.
 * - Allow overriding the threshold with the `LOG_LEVEL` env var
 *   (`debug` | `info` | `warn` | `error` | `silent`).
 *
 * This is for diagnostic console output only. To persist operational/user-facing
 * errors to the database (and the in-app Log tab), use `logError` from
 * `src/lib/error-logger.ts`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

function resolveThreshold(): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase()
  if (explicit && explicit in LEVEL_WEIGHT) {
    return explicit as LogLevel
  }
  // Default: quiet in production (warnings/errors only), verbose elsewhere.
  return process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
}

const threshold = resolveThreshold()

function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[threshold]
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * Create a logger scoped to a tag. The tag is prefixed as `[Tag]` to match the
 * project's existing console style, e.g. `createLogger('Generate').error('boom')`
 * prints `[Generate] boom`.
 */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`
  return {
    debug: (...args) => {
      if (shouldLog('debug')) console.debug(prefix, ...args)
    },
    info: (...args) => {
      if (shouldLog('info')) console.info(prefix, ...args)
    },
    warn: (...args) => {
      if (shouldLog('warn')) console.warn(prefix, ...args)
    },
    error: (...args) => {
      if (shouldLog('error')) console.error(prefix, ...args)
    },
  }
}

/** Unscoped logger for cases where a tag isn't meaningful. */
export const logger: Logger = {
  debug: (...args) => {
    if (shouldLog('debug')) console.debug(...args)
  },
  info: (...args) => {
    if (shouldLog('info')) console.info(...args)
  },
  warn: (...args) => {
    if (shouldLog('warn')) console.warn(...args)
  },
  error: (...args) => {
    if (shouldLog('error')) console.error(...args)
  },
}
