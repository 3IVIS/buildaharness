import { describe, expect, it } from 'vitest'
import { displayWidth as oracleWidth } from './testkit/display-width.js'
import { displayWidth, fitLabel, sanitizeLabel } from './plan-width.js'

describe('plan-width', () => {
  it('agrees with the independent oracle implementation', () => {
    for (const s of ['abc', '数据收集', 'データ', '🚀 go', 'é', 'é', '✓ ○ ▶ ⊘ ⏸ ◔', 'a‍b']) expect(displayWidth(s)).toBe(oracleWidth(s))
  })
  it('fitLabel never exceeds the limit and never splits a wide character', () => {
    for (const max of [1, 2, 3, 8, 9]) for (const s of ['数据收集与分析', 'abcdefghijklmnop', '🚀🚀🚀🚀']) expect(displayWidth(fitLabel(s, max))).toBeLessThanOrEqual(max)
    expect(fitLabel('short', 8)).toBe('short')
  })
  it('sanitizeLabel removes control, bidi and zero-width characters', () => {
    expect(sanitizeLabel('  a\u0007b‮ c\n\td​ ')).toBe('ab c d')
    expect(sanitizeLabel('é')).toBe('é')
  })
})
