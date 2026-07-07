/**
 * Static, approximate per-model pricing — a fallback used only by the proxy backend's /cost
 * display. The proxy (packages/proxy/src/forward.ts) is a thin pass-through to Anthropic/
 * OpenAI and never computes or returns a dollar cost itself, only the raw token counts each
 * provider's response already includes. This table is NOT billing-accurate: it doesn't account
 * for prompt-caching discounts, batch pricing, or any rate change since it was last updated —
 * update the numbers below if Anthropic's published pricing changes. The Claude CLI backend
 * needs no such table; its costUsd comes from Claude's own real accounting (see
 * claude-cli-prompt.ts's parseClaudeCliOutput).
 */
export interface ModelPriceUsd {
  inputPerMTok: number
  outputPerMTok: number
}

const PRICING_BY_TIER = {
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
} as const satisfies Record<string, ModelPriceUsd>

type ModelTier = keyof typeof PRICING_BY_TIER

/** Matches by substring rather than an exact model-id list, since versioned date suffixes (e.g. -20241022) change more often than the pricing tier itself. */
function classifyModelTier(model: string): ModelTier | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return undefined
}

/** Returns undefined (rather than a misleading number) when the model is unset or not a recognized Claude tier — callers must not silently treat "no estimate" as "free". */
export function estimateCostUsd(model: string | undefined, usage: { inputTokens: number; outputTokens: number }): number | undefined {
  if (!model) return undefined
  const tier = classifyModelTier(model)
  if (!tier) return undefined
  const price = PRICING_BY_TIER[tier]
  return (usage.inputTokens / 1_000_000) * price.inputPerMTok + (usage.outputTokens / 1_000_000) * price.outputPerMTok
}
