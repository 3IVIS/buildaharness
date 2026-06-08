import { describe, it, expect } from 'vitest'
import { normalise, assertNormalised, DimensionType, NormalisationError } from './normalise.js'

describe('normalise', () => {
  it('ratio clamps -0.1 → 0.0 and 1.1 → 1.0; 0.5 unchanged', () => {
    expect(normalise(-0.1, DimensionType.ratio)).toBe(0.0)
    expect(normalise(1.1, DimensionType.ratio)).toBe(1.0)
    expect(normalise(0.5, DimensionType.ratio)).toBe(0.5)
  })

  it('entropy returns 1.0 for uniform distribution over 4 sources', () => {
    const result = normalise([1, 1, 1, 1], DimensionType.entropy)
    expect(result).toBeCloseTo(1.0)
  })

  it('composite weighted sum normalised to [0,1]', () => {
    // components=[0.8, 0.4], weights=[3, 1] → (0.8*3 + 0.4*1)/4 = (2.4+0.4)/4 = 0.7
    const result = normalise({ components: [0.8, 0.4], weights: [3, 1] }, DimensionType.composite)
    expect(result).toBeCloseTo(0.7)
  })

  it('match_confidence clamps same as ratio', () => {
    expect(normalise(-0.5, DimensionType.match_confidence)).toBe(0.0)
    expect(normalise(1.5, DimensionType.match_confidence)).toBe(1.0)
    expect(normalise(0.85, DimensionType.match_confidence)).toBe(0.85)
  })
})

describe('assertNormalised', () => {
  it('throws NormalisationError for -0.01 (below floor)', () => {
    expect(() => assertNormalised(-0.01, 'test_dim')).toThrow(NormalisationError)
  })

  it('throws NormalisationError for 1.01 (above ceiling)', () => {
    expect(() => assertNormalised(1.01, 'test_dim')).toThrow(NormalisationError)
  })

  it('does not throw for 0.0, 0.5, 1.0', () => {
    expect(() => assertNormalised(0.0, 'x')).not.toThrow()
    expect(() => assertNormalised(0.5, 'x')).not.toThrow()
    expect(() => assertNormalised(1.0, 'x')).not.toThrow()
  })
})
