import { describe, it, expect } from 'vitest'
import { getNegationPairs, getReviewNegationTriggers, getConstraintNegationWords, getGranularityMarkers } from './patterns.js'

describe('getNegationPairs', () => {
  it('loads the same pairs/stopwords/polarity words detect-contradictions.ts relies on', () => {
    const { pairs, stopwords, polarityWords } = getNegationPairs()
    expect(pairs).toContainEqual(['passed', 'failed'])
    expect(pairs).toContainEqual(['online', 'offline'])
    expect(stopwords.has('the')).toBe(true)
    expect(polarityWords).toEqual(['not', 'absent', 'no'])
  })
})

describe('getReviewNegationTriggers', () => {
  it('loads the same triggers/stopwords review-proposed-change.ts relies on', () => {
    const { triggers, stopwords } = getReviewNegationTriggers()
    expect(triggers).toContain('not ')
    expect(triggers).toContain('no longer ')
    expect(stopwords.has('and')).toBe(true)
  })
})

describe('getConstraintNegationWords', () => {
  it('loads the same 6-word set output-validation.ts and adapter/harness/output_contract.py both previously hardcoded independently', () => {
    const words = getConstraintNegationWords()
    for (const w of ['not', 'never', 'no', 'without', 'exclude', 'must not']) {
      expect(words.has(w)).toBe(true)
    }
  })
})

describe('getGranularityMarkers', () => {
  it('merges what used to be detect-contradictions.ts\'s LINE_LEVEL_KEYWORDS and update-diagnostics.ts\'s own statementMarkers/functionMarkers', () => {
    const { statementLevelMarkers, functionLevelMarkers } = getGranularityMarkers()
    for (const m of ['line ', 'line\t', ':line', ' ln ', ' l', 'column ', 'char ', 'line:', 'statement', 'expression', 'lineno']) {
      expect(statementLevelMarkers).toContain(m)
    }
    for (const m of ['function', 'method', 'def ', 'procedure', '()']) {
      expect(functionLevelMarkers).toContain(m)
    }
  })
})
