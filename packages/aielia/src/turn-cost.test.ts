import { describe, it, expect } from 'vitest'
import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from '@buildaharness/runtime'
import { withCostEstimate } from './turn-cost.js'
import { estimateCostUsd } from './model-pricing.js'

const usage = { inputTokens: 1000, outputTokens: 500 }

describe('withCostEstimate', () => {
  it('leaves claude-cli usage unchanged', () => {
    expect(withCostEstimate(usage, { backend: 'claude-cli', model: ANTHROPIC_DEFAULT_MODEL })).toBe(usage)
  })
  it('never overwrites a real costUsd', () => {
    const real = { ...usage, costUsd: 0.5 }
    expect(withCostEstimate(real, { backend: 'openrouter', model: 'x' })).toBe(real)
  })
  it('prices with the configured model first', () => {
    expect(withCostEstimate(usage, { backend: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL }).costUsd).toBe(estimateCostUsd(ANTHROPIC_DEFAULT_MODEL, usage))
  })
  it("falls back to the backend's own default model, not the Anthropic one", () => {
    expect(withCostEstimate(usage, { backend: 'openai' }).costUsd).toBe(estimateCostUsd(OPENAI_DEFAULT_MODEL, usage))
  })
  it('falls back to the Anthropic default with no backend and no model (the spend cap path)', () => {
    expect(withCostEstimate(usage, {}).costUsd).toBe(estimateCostUsd(ANTHROPIC_DEFAULT_MODEL, usage))
  })
  it('returns the usage unchanged when the model is not in the price table', () => {
    expect(withCostEstimate(usage, { backend: 'proxy', model: 'unknown-model-xyz' })).toBe(usage)
  })
})
