import { describe, it, expect } from 'vitest'
import { estimateCostUsd } from './model-pricing.js'

describe('estimateCostUsd', () => {
  it('returns undefined when no model is given', () => {
    expect(estimateCostUsd(undefined, { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined()
  })

  it('returns undefined for a model that does not match a known tier', () => {
    expect(estimateCostUsd('some-unknown-model', { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined()
  })

  it('prices OpenAI models, most specific family first', () => {
    expect(estimateCostUsd('gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(2.5 + 10)
    expect(estimateCostUsd('gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.15)
    expect(estimateCostUsd('gpt-4.1-mini-2025-04-14', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.4)
    expect(estimateCostUsd('openai/gpt-4.1', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(8)
  })

  it('bills cached input tokens at the cached rate, as a subset of inputTokens', () => {
    expect(estimateCostUsd('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 })).toBe(0.5 * 2.5 + 0.5 * 1.25)
  })

  it('bills cachedInputTokens at the cached rate for a model that has one', () => {
    expect(estimateCostUsd('claude-sonnet-4', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 })).toBeCloseTo(1.5 + 0.15, 6)
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

describe('estimateCostUsd with a prompt cache (Anthropic)', () => {
  it('bills cache reads at a tenth and cache writes at 1.25x the input rate', () => {
    // sonnet: 3 / 15 per MTok. 1,000,000 input = 900,000 read + 100,000 written + 0 plain; 0 output
    expect(estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000, cacheWriteTokens: 100_000 })).toBeCloseTo(0.27 + 0.375, 6)
  })
})
