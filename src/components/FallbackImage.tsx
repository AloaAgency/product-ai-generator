'use client'

import { useMemo, useState, type ImgHTMLAttributes, type ReactNode } from 'react'

type FallbackImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  sources: Array<string | null | undefined>
  fallback?: ReactNode
}

const normalizeSource = (source: string | null | undefined) => {
  const trimmed = source?.trim()
  return trimmed || null
}

export function FallbackImage({ sources, fallback = null, alt = '', ...imgProps }: FallbackImageProps) {
  const validSources = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []

    for (const source of sources) {
      const normalized = normalizeSource(source)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }

    return result
  }, [sources])

  const sourceKey = validSources.join('\n')
  const [failedState, setFailedState] = useState({ sourceKey: '', failedCount: 0 })
  const sourceIndex = failedState.sourceKey === sourceKey ? failedState.failedCount : 0

  const src = validSources[sourceIndex]
  if (!src) return <>{fallback}</>

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...imgProps}
      src={src}
      alt={alt}
      onError={() => {
        setFailedState((state) => ({
          sourceKey,
          failedCount: state.sourceKey === sourceKey ? state.failedCount + 1 : 1,
        }))
      }}
    />
  )
}
