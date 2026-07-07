import { describe, it, expect } from 'vitest'
import { estimateCostUsd } from './model-pricing.js'

describe('estimateCostUsd', () => {
  it('returns undefined when no model is given', () => {
    expect(estimateCostUsd(undefined, { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined()
  })

  it('returns undefined for a model that does not match a known tier', () => {
    expect(estimateCostUsd('gpt-4o', { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined()
  })

  it('estimates cost for a sonnet model, matching by substring regardless of date suffix', () => {
    const cost = estimateCostUsd('claude-3-5-sonnet-20241022', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBe(3 + 15)
  })

  it('estimates cost for an opus model', () => {
    const cost = estimateCostUsd('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 })
    expect(cost).toBe(15)
  })

  it('estimates cost for a haiku model', () => {
    const cost = estimateCostUsd('claude-haiku-4-5-20251001', { inputTokens: 0, outputTokens: 1_000_000 })
    expect(cost).toBe(5)
  })

  it('matches tier names case-insensitively', () => {
    expect(estimateCostUsd('Claude-Sonnet-Test', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3)
  })

  it('scales linearly with token counts below a million', () => {
    const cost = estimateCostUsd('claude-3-5-sonnet-20241022', { inputTokens: 500_000, outputTokens: 0 })
    expect(cost).toBe(1.5)
  })
})
