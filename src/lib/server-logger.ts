import {
  createLoggerWithThreshold,
  createUnscopedLoggerWithThreshold,
  type LogLevel,
} from '@/lib/logger'

const LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error', 'silent'])

function resolveServerThreshold(): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase()
  if (explicit && LEVELS.has(explicit as LogLevel)) return explicit as LogLevel
  return process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
}

const serverThreshold = resolveServerThreshold()
const getServerThreshold = () => serverThreshold

/** Server logger; preserves LOG_LEVEL support without exposing it to clients. */
export function createLogger(scope: string) {
  return createLoggerWithThreshold(scope, getServerThreshold)
}

export const logger = createUnscopedLoggerWithThreshold(getServerThreshold)
