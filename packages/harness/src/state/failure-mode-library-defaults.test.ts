import { describe, it, expect } from 'vitest'
import { DEFAULT_FAILURE_MODE_ENTRIES } from './failure-diagnostics.js'

// The unavailable-service entry also has to describe the transient errors a model call actually throws — overloaded, rate-limited,
// timing out — so the semantic matcher classifies them. Checked against real error texts with a real model (eval/layers/failure_match,
// 2026-10-01): before the wording below only 4 of 6 transient errors matched (a 429 and a timeout did not).

describe('the curated unavailable-service entry', () => {
  const entry = DEFAULT_FAILURE_MODE_ENTRIES.find((e) => e.id === 'tool-unavailable-cascade')!

  it('lists rate-limit and timeout symptoms next to the unavailable / refused ones', () => {
    expect(entry.symptoms).toEqual(expect.arrayContaining(['service unavailable', 'connection refused', 'rate limit exceeded', 'too many requests', 'request timed out']))
  })

  it('describes overloaded, rate-limited and timing-out services, and still points at a different approach', () => {
    expect(entry.pattern_description).toMatch(/overloaded/)
    expect(entry.pattern_description).toMatch(/rate-limited/)
    expect(entry.pattern_description).toMatch(/timing out/)
    expect(entry.strategy_affinity).toBe('REIMPLEMENT')
  })
})
