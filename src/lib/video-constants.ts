export const VEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const
export const VEO_ASPECT_RATIOS = ['16:9', '9:16'] as const
export const VEO_DURATIONS = [4, 6, 8] as const
export const LTX_RESOLUTIONS = ['1920x1080', '2560x1440', '3840x2160'] as const
export const DEFAULT_VEO = { resolution: '1080p', aspectRatio: '16:9', duration: 8, generateAudio: true }
export const DEFAULT_LTX = { resolution: '1920x1080', duration: 8, fps: 25, generateAudio: true }

export const isLtxModel = (model: string | null | undefined) => {
  if (!model) return false
  return model.toLowerCase().startsWith('ltx')
}

export const supportsEndFrame = (model: string | null | undefined) => !isLtxModel(model)

export const supportsAudioToggle = (model: string | null | undefined) => isLtxModel(model)

export const veoRequires8s = (resolution: string | null | undefined, hasStartFrame: boolean, hasEndFrame: boolean) => {
  if (hasStartFrame || hasEndFrame) return true
  const res = (resolution || '').toLowerCase()
  return res === '1080p' || res === '4k'
}

export const normalizeDurationValue = (model: string, value: unknown, resolution?: string | null, hasStartFrame?: boolean, hasEndFrame?: boolean) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  if (isLtxModel(model)) return parsed
  if (veoRequires8s(resolution, !!hasStartFrame, !!hasEndFrame)) return 8
  if (VEO_DURATIONS.includes(parsed as (typeof VEO_DURATIONS)[number])) return parsed
  return VEO_DURATIONS.reduce((closest, current) => {
    const currentDiff = Math.abs(current - parsed)
    const closestDiff = Math.abs(closest - parsed)
    if (currentDiff < closestDiff) return current
    if (currentDiff === closestDiff && current > closest) return current
    return closest
  }, VEO_DURATIONS[0])
}

export const parsePositiveNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}
