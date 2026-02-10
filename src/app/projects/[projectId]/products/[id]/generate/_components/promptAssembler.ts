export interface PromptEnhancementValues {
  shotType: string
  customShotType: string
  angle: string
  color: string
  location: string
  lighting: string
  weather: string
}

export const DEFAULT_ENHANCEMENTS: PromptEnhancementValues = {
  shotType: 'none',
  customShotType: '',
  angle: 'none',
  color: '',
  location: '',
  lighting: '',
  weather: '',
}

export function assemblePrompt(basePrompt: string, enhancements: PromptEnhancementValues): string {
  const parts: string[] = []

  const shot = enhancements.shotType === 'custom'
    ? enhancements.customShotType.trim()
    : enhancements.shotType !== 'none' ? enhancements.shotType : ''
  if (shot) parts.push(`Shot type: ${shot}`)

  if (enhancements.angle && enhancements.angle !== 'none') {
    parts.push(`Camera angle: ${enhancements.angle}`)
  }

  if (enhancements.color.trim()) {
    parts.push(`Featuring color ${enhancements.color.trim()}`)
  }

  if (enhancements.location.trim()) {
    parts.push(`Location: ${enhancements.location.trim()}`)
  }

  if (enhancements.lighting.trim()) {
    parts.push(`Lighting: ${enhancements.lighting.trim()}`)
  }

  if (enhancements.weather.trim()) {
    parts.push(`Weather: ${enhancements.weather.trim()}`)
  }

  if (parts.length === 0) return basePrompt

  const base = basePrompt.trimEnd()
  const separator = base.endsWith('.') ? ' ' : '. '
  return base + separator + parts.join('. ') + '.'
}
