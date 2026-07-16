import { describe, it, expect } from 'vitest'
import { scoreEntries } from './scoring'

describe('scoreEntries', () => {
  it('an exact-substring match still scores exactly 1.0 and still ranks at the top', () => {
    const entries: Array<[string, unknown]> = [
      ['a', 'the quick brown fox'],
      ['b', 'a slow turtle'],
    ]
    const results = scoreEntries(entries, 'quick', 5, 0.0)
    expect(results[0].key).toBe('a')
    expect(results[0].score).toBe(1.0)
  })

  it('a value whose tokens all match the query but not as a contiguous substring scores strictly below 1.0', () => {
    const entries: Array<[string, unknown]> = [['a', 'appointment for the dentist']]
    const results = scoreEntries(entries, 'dentist appointment', 5, 0.0)
    expect(results[0].score).toBeLessThan(1.0)
    expect(results[0].score).toBeGreaterThan(0)
    expect(results[0].score).toBeLessThanOrEqual(0.95)
  })

  it('a query matching only a JSON key name does not score above 0', () => {
    const entries: Array<[string, unknown]> = [['a', { role: 'user', content: 'hello there' }]]
    const results = scoreEntries(entries, 'role', 5, 0.0)
    expect(results[0].score).toBe(0)
  })

  it('a multi-term query ranks a value containing more matching terms above one containing fewer', () => {
    const entries: Array<[string, unknown]> = [
      ['fewer', 'dentist visit'],
      ['more', 'dentist appointment checkup visit'],
    ]
    const results = scoreEntries(entries, 'dentist appointment checkup', 5, 0.0)
    expect(results[0].key).toBe('more')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('a stopword-only difference does not change ranking', () => {
    const entries: Array<[string, unknown]> = [['a', 'appointment for the dentist']]
    const withStopword = scoreEntries(entries, 'the dentist appointment', 5, 0.0)
    const withoutStopword = scoreEntries(entries, 'dentist appointment', 5, 0.0)
    expect(withStopword[0].score).toBe(withoutStopword[0].score)
  })

  it('minScore still excludes low-overlap entries', () => {
    const entries: Array<[string, unknown]> = [
      ['low', 'unrelated content entirely'],
      ['high', 'dentist appointment'],
    ]
    const results = scoreEntries(entries, 'dentist appointment', 5, 0.5)
    expect(results.map((r) => r.key)).toEqual(['high'])
  })

  it('handles an empty query without throwing', () => {
    const entries: Array<[string, unknown]> = [['a', 'hello']]
    expect(() => scoreEntries(entries, '', 5, 0.0)).not.toThrow()
  })

  it('handles an empty entry set without throwing', () => {
    expect(() => scoreEntries([], 'dentist', 5, 0.0)).not.toThrow()
    expect(scoreEntries([], 'dentist', 5, 0.0)).toEqual([])
  })

  it('topK still truncates correctly with non-binary scores', () => {
    const entries: Array<[string, unknown]> = [
      ['a', 'dentist appointment checkup'],
      ['b', 'dentist appointment'],
      ['c', 'dentist'],
      ['d', 'unrelated'],
    ]
    const results = scoreEntries(entries, 'dentist appointment checkup', 2, 0.0)
    expect(results).toHaveLength(2)
    expect(results[0].key).toBe('a')
    expect(results[1].key).toBe('b')
  })
})
