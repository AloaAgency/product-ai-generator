'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PromptEnhancementValues } from './promptAssembler'

const SHOT_TYPES = [
  'None',
  'Extreme Close Up',
  'Close Up',
  'Medium',
  'Wide',
  'Extreme Wide',
  'Custom',
] as const

const ANGLES = [
  'None',
  'Eye Level',
  'Low Angle',
  'Overhead',
  "Bird's Eye View",
  'Directly Overhead (Top Down)',
] as const

interface PromptEnhancementsProps {
  values: PromptEnhancementValues
  onChange: (values: PromptEnhancementValues) => void
}

export function PromptEnhancements({ values, onChange }: PromptEnhancementsProps) {
  const [locationOpen, setLocationOpen] = useState(
    !!(values.location || values.lighting || values.weather)
  )

  const update = (partial: Partial<PromptEnhancementValues>) => {
    onChange({ ...values, ...partial })
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-300">Prompt Enhancements</h2>

      {/* Row 1: Shot Type + Angle */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-400">Shot Type</label>
          <div className="relative">
            <select
              value={values.shotType}
              onChange={(e) => update({ shotType: e.target.value })}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {SHOT_TYPES.map((type) => (
                <option key={type} value={type === 'None' ? 'none' : type === 'Custom' ? 'custom' : type}>
                  {type}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
          {values.shotType === 'custom' && (
            <input
              type="text"
              placeholder="Custom shot type..."
              value={values.customShotType}
              onChange={(e) => update({ customShotType: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-400">Angle</label>
          <div className="relative">
            <select
              value={values.angle}
              onChange={(e) => update({ angle: e.target.value })}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {ANGLES.map((angle) => (
                <option key={angle} value={angle === 'None' ? 'none' : angle}>
                  {angle}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
        </div>
      </div>

      {/* Row 2: Color */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-400">Color</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="#FF5500"
            value={values.color}
            onChange={(e) => update({ color: e.target.value })}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <input
            type="color"
            value={values.color || '#000000'}
            onChange={(e) => update({ color: e.target.value })}
            className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 p-0.5"
          />
        </div>
      </div>

      {/* Collapsible Location Section */}
      <div className="rounded-lg border border-zinc-800">
        <button
          type="button"
          onClick={() => setLocationOpen(!locationOpen)}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {locationOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Location & Environment
        </button>
        {locationOpen && (
          <div className="space-y-3 px-3 pb-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Location</label>
              <input
                type="text"
                placeholder="e.g. outdoor garden, studio, beach..."
                value={values.location}
                onChange={(e) => update({ location: e.target.value })}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Lighting</label>
              <input
                type="text"
                placeholder="e.g. natural sunlight, studio lighting..."
                value={values.lighting}
                onChange={(e) => update({ lighting: e.target.value })}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Weather</label>
              <input
                type="text"
                placeholder="e.g. overcast, sunny, foggy..."
                value={values.weather}
                onChange={(e) => update({ weather: e.target.value })}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
