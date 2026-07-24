import { describe, it, expect } from 'vitest'
import { getNegationPairs, getReviewNegationTriggers } from './patterns.js'

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
