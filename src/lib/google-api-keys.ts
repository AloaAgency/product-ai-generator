import type { GlobalStyleSettings, GoogleApiKeyConfig } from './types'

type UnknownRecord = Record<string, unknown>

function asTrimmedString(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed
}

function toGoogleApiKeyConfig(value: unknown, index: number): GoogleApiKeyConfig | null {
  if (!value || typeof value !== 'object') return null
  const item = value as UnknownRecord
  const key = asTrimmedString(item.key ?? item.api_key ?? item.apiKey)
  if (!key) return null
  const label = asTrimmedString(item.label) || `Key ${index + 1}`
  const id = asTrimmedString(item.id) || `google-key-${index + 1}`
  return { id, label, key }
}

function sanitizeGoogleApiKeys(value: unknown): GoogleApiKeyConfig[] {
  if (!Array.isArray(value)) return []
  const parsed = value
    .map((item, index) => toGoogleApiKeyConfig(item, index))
    .filter((item): item is GoogleApiKeyConfig => Boolean(item))

  // Keep first instance of every id to avoid select ambiguity.
  const seenIds = new Set<string>()
  const deduped: GoogleApiKeyConfig[] = []
  for (const item of parsed) {
    if (seenIds.has(item.id)) continue
    seenIds.add(item.id)
    deduped.push(item)
  }
  return deduped
}

export function listGoogleApiKeys(
  settings?: GlobalStyleSettings | null,
  options: { includeLegacyFallback?: boolean } = {}
): GoogleApiKeyConfig[] {
  const includeLegacyFallback = options.includeLegacyFallback ?? true
  const parsed = sanitizeGoogleApiKeys(settings?.google_api_keys)

  if (parsed.length > 0 || !includeLegacyFallback) return parsed

  const legacyKey = asTrimmedString(settings?.gemini_api_key)
  if (!legacyKey) return []

  return [{ id: 'legacy-gemini-key', label: 'Primary Key', key: legacyKey }]
}

export function resolveActiveGoogleApiKeyId(
  settings?: GlobalStyleSettings | null,
  options: { includeLegacyFallback?: boolean } = {}
): string | undefined {
  const keys = listGoogleApiKeys(settings, options)
  if (keys.length === 0) return undefined
  const preferredId = asTrimmedString(settings?.active_google_api_key_id)
  if (preferredId && keys.some((item) => item.id === preferredId)) {
    return preferredId
  }
  return keys[0].id
}

export function resolveGoogleApiKey(
  settings?: GlobalStyleSettings | null,
  options: { includeLegacyFallback?: boolean } = {}
): string | undefined {
  const keys = listGoogleApiKeys(settings, options)
  if (keys.length === 0) return undefined
  const activeId = resolveActiveGoogleApiKeyId(settings, options)
  const active = keys.find((item) => item.id === activeId)
  return active?.key || keys[0].key
}

export function normalizeGoogleApiKeySettings(
  settings?: GlobalStyleSettings | null,
  options: { includeLegacyFallback?: boolean } = {}
): GlobalStyleSettings {
  const source = settings ?? {}
  const keys = listGoogleApiKeys(source, options)
  const activeId = resolveActiveGoogleApiKeyId(source, options)
  const activeKey =
    keys.find((item) => item.id === activeId)?.key ||
    keys[0]?.key ||
    undefined

  return {
    ...source,
    google_api_keys: keys.length > 0 ? keys : undefined,
    active_google_api_key_id: activeId,
    gemini_api_key: activeKey,
  }
}

export function createGoogleApiKeyId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch {
    // No-op fallback below.
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
