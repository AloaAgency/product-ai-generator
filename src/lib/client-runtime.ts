const DEVELOPMENT_ENVIRONMENT = 'development'

/**
 * The server-rendered root layout publishes only the non-sensitive runtime
 * classification needed by client diagnostics. Client code must not inspect
 * non-NEXT_PUBLIC environment variables directly.
 */
export function isClientDevelopmentRuntime() {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.appEnvironment === DEVELOPMENT_ENVIRONMENT
}
