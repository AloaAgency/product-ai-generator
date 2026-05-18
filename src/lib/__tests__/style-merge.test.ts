import { describe, it, expect } from 'vitest'

import { mergeStyles } from '../style-merge'

/**
 * Tests for mergeStyles — the function that combines project-level global style
 * settings with product-level overrides.
 *
 * The subtle invariant: empty strings and null/undefined product values must NOT
 * override a defined project value. A misconfigured merge here would silently
 * cause a product to inherit wrong photographic settings (e.g. wrong lens or
 * lighting) whenever the product has a blank field.
 */
describe('mergeStyles', () => {
  it('returns an empty object when both inputs are undefined', () => {
    expect(mergeStyles(undefined, undefined)).toStrictEqual({})
  })

  it('returns the project settings when product settings are undefined', () => {
    const project = { lens: '85mm', lighting: 'natural' }
    expect(mergeStyles(project, undefined)).toStrictEqual({ lens: '85mm', lighting: 'natural' })
  })

  it('returns the product settings when project settings are undefined', () => {
    const product = { lens: '50mm', style: 'editorial' }
    expect(mergeStyles(undefined, product)).toStrictEqual({ lens: '50mm', style: 'editorial' })
  })

  it('lets product values override matching project values', () => {
    const project = { lens: '85mm', lighting: 'softbox' }
    const product = { lens: '50mm' }
    const result = mergeStyles(project, product)
    expect(result.lens).toBe('50mm')
    expect(result.lighting).toBe('softbox')
  })

  it('preserves project values for keys absent from the product', () => {
    const project = { lens: '85mm', color_grading: 'cinematic' }
    const product = { style: 'editorial' }
    const result = mergeStyles(project, product)
    expect(result.lens).toBe('85mm')
    expect(result.color_grading).toBe('cinematic')
    expect(result.style).toBe('editorial')
  })

  // -------------------------------------------------------------------------
  // Critical edge cases: empty / null / undefined product values must fall
  // through to the project default rather than overwriting it with nothing.
  // -------------------------------------------------------------------------

  it('does NOT let an empty string product value override a project value', () => {
    const project = { lens: '85mm' }
    const product = { lens: '' }
    const result = mergeStyles(project, product)
    // Empty string must not win — project value should be preserved.
    expect(result.lens).toBe('85mm')
  })

  it('does NOT let a whitespace-only product value override a project value', () => {
    const project = { lighting: 'softbox' }
    const product = { lighting: '   ' }
    const result = mergeStyles(project, product)
    // Whitespace-only string is treated as empty — project value survives.
    expect(result.lighting).toBe('softbox')
  })

  it('does NOT let a null product value override a project value', () => {
    const project = { style: 'editorial' }
    // TypeScript types don't allow null here, but runtime data from the DB can
    // contain nulls. Cast to exercise the guard.
    const product = { style: null as unknown as string }
    const result = mergeStyles(project, product)
    expect(result.style).toBe('editorial')
  })

  it('does NOT let an undefined product value override a project value', () => {
    const project = { camera_height: 'eye level' }
    const product = { camera_height: undefined }
    const result = mergeStyles(project, product)
    expect(result.camera_height).toBe('eye level')
  })

  it('handles all overrideable fields correctly in a full merge', () => {
    const project = {
      subject_rule: 'full product in frame',
      lens: '85mm',
      camera_height: 'eye level',
      color_grading: 'natural',
      lighting: 'softbox',
      style: 'clean',
      constraints: 'no hands',
      reference_rule: 'match exactly',
    }
    const product = {
      lens: '50mm',         // override
      camera_height: '',    // empty → fall through
      lighting: 'backlit',  // override
      style: undefined,     // undefined → fall through
    }

    const result = mergeStyles(project, product)

    expect(result.subject_rule).toBe('full product in frame')   // unchanged
    expect(result.lens).toBe('50mm')                             // overridden
    expect(result.camera_height).toBe('eye level')              // fell through
    expect(result.color_grading).toBe('natural')                // unchanged
    expect(result.lighting).toBe('backlit')                     // overridden
    expect(result.style).toBe('clean')                          // fell through
    expect(result.constraints).toBe('no hands')                 // unchanged
    expect(result.reference_rule).toBe('match exactly')         // unchanged
  })

  it('allows a non-empty product value to override a project boolean-like field (default_resolution)', () => {
    const project = { default_resolution: '4K' as const }
    const product = { default_resolution: '2K' as const }
    const result = mergeStyles(project, product)
    expect(result.default_resolution).toBe('2K')
  })

  it('does not mutate either input object', () => {
    const project = { lens: '85mm' }
    const product = { lens: '50mm', lighting: 'natural' }
    const projectCopy = { ...project }
    const productCopy = { ...product }

    mergeStyles(project, product)

    expect(project).toStrictEqual(projectCopy)
    expect(product).toStrictEqual(productCopy)
  })
})
