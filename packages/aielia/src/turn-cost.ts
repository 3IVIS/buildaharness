import { ANTHROPIC_DEFAULT_MODEL, defaultModelForBackend, type TokenUsage } from '@buildaharness/runtime'
import { estimateCostUsd } from './model-pricing.js'

/**
 * Adds a static-table cost estimate to a turn's usage. claude-cli (total_cost_usd) and openrouter
 * (usage.cost) report a real dollar cost, and a real `costUsd` is never overwritten; every other
 * case (proxy, anthropic, openai: token counts only) gets an approximate estimate, see model-pricing.ts.
 * The model is `model`, else the backend's own default, else the Anthropic default. One function for the
 * CLI's /cost, the apps' cost line and the spend cap, so they cannot disagree.
 */
export function withCostEstimate(usage: TokenUsage, { backend, model }: { backend?: string; model?: string }): TokenUsage {
  if (backend === 'claude-cli' || usage.costUsd !== undefined) return usage
  const priced = model ?? (backend ? defaultModelForBackend(backend) : undefined) ?? ANTHROPIC_DEFAULT_MODEL
  const estimated = estimateCostUsd(priced, usage)
  return estimated !== undefined ? { ...usage, costUsd: estimated } : usage
}
