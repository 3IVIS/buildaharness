import { describe, it, expect } from 'vitest'
import { CLAIMS, evaluateClaims } from './check-comparison-claims.mjs'

/**
 * F9: the checker IS the test, but the checker itself needs coverage so a broken resolver
 * (always-true, always-false, or a typo'd path) doesn't pass CI silently.
 */
describe('check-comparison-claims', () => {
  it('every claim has an id, a description, a boolean expected, and a resolver', () => {
    for (const c of CLAIMS) {
      expect(typeof c.id).toBe('string')
      expect(c.description.length).toBeGreaterThan(10)
      expect(typeof c.expected).toBe('boolean')
      expect(typeof c.resolve).toBe('function')
    }
  })

  it('claim ids are unique', () => {
    expect(new Set(CLAIMS.map((c) => c.id)).size).toBe(CLAIMS.length)
  })

  it('every resolver returns a boolean without throwing', () => {
    for (const c of CLAIMS) {
      expect(typeof c.resolve(), c.id).toBe('boolean')
    }
  })

  it('every claim currently matches the code (evaluateClaims reports nothing)', () => {
    expect(evaluateClaims().map((d) => d.claim.id)).toEqual([])
  })

  it('resolvers are discriminating — the "true" and "false" claims do not all agree', () => {
    // If every resolver were stubbed the same way this would fail, catching an always-true/
    // always-false regression that "every claim matches" alone would miss.
    const results = CLAIMS.map((c) => c.resolve())
    expect(results).toContain(true)
    expect(results).toContain(false)
  })

  it('the send-effect-tool claim is still false (F2 unresolved) and web_search_on_claude_cli is true (F3 landed)', () => {
    expect(CLAIMS.find((c) => c.id === 'send_effect_tool').resolve()).toBe(false)
    expect(CLAIMS.find((c) => c.id === 'web_search_on_claude_cli').resolve()).toBe(true)
  })
})
