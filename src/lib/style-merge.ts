import type { GlobalStyleSettings } from './types'

/**
 * Merge project-level styles with product-level styles.
 * Product values override project defaults. Empty/undefined product values
 * fall through to the project default.
 */
export function mergeStyles(
  projectStyles: GlobalStyleSettings | undefined,
  productStyles: GlobalStyleSettings | undefined
): GlobalStyleSettings {
  const base = projectStyles ?? {}
  const override = productStyles ?? {}
  const merged: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    merged[key] = value
  }

  return merged as GlobalStyleSettings
}
