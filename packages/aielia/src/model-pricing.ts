/**
 * Static, approximate per-model pricing — a fallback for every backend whose response carries
 * token counts but no dollar figure. Anthropic and OpenAI responses report tokens only; OpenRouter
 * (usage.cost) and the Claude CLI (total_cost_usd) report a real cost, which callers prefer over
 * this table. This table is NOT billing-accurate: it ignores batch pricing, long-context tiers and
 * any rate change since it was last updated — update the numbers below when published pricing changes.
 */
export interface ModelPriceUsd {
  inputPerMTok: number
  outputPerMTok: number
  /** Rate for input tokens served from the provider's prompt cache; absent = same as inputPerMTok. */
  cachedInputPerMTok?: number
}

const PRICING_BY_TIER = {
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
} as const satisfies Record<string, ModelPriceUsd>

/**
 * OpenAI families, ordered most-specific first — matching is by substring, so "gpt-4.1-mini"
 * must be tested before "gpt-4.1". OpenRouter ids ("openai/gpt-4o") match too.
 */
const OPENAI_PRICING: ReadonlyArray<readonly [string, ModelPriceUsd]> = [
  ['gpt-4.1-nano', { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.025 }],
  ['gpt-4.1-mini', { inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.1 }],
  ['gpt-4.1', { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 }],
  ['gpt-4o-mini', { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 }],
  ['gpt-4o', { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 }],
]

/** Matches by substring rather than an exact model-id list, since versioned date suffixes (e.g. -20241022) change more often than the pricing tier itself. */
function priceForModel(model: string): ModelPriceUsd | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return PRICING_BY_TIER.opus
  if (lower.includes('sonnet')) return PRICING_BY_TIER.sonnet
  if (lower.includes('haiku')) return PRICING_BY_TIER.haiku
  return OPENAI_PRICING.find(([key]) => lower.includes(key))?.[1]
}

/**
 * Returns undefined (rather than a misleading number) when the model is unset or not a recognized one — callers must not silently treat "no estimate" as "free".
 * `cachedInputTokens` follows OpenAI's convention (a subset of inputTokens, billed at the cached rate); it is ignored for models with no cached rate.
 */
export function estimateCostUsd(model: string | undefined, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): number | undefined {
  if (!model) return undefined
  const price = priceForModel(model)
  if (!price) return undefined
  const cached = price.cachedInputPerMTok !== undefined ? Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens) : 0
  const uncached = usage.inputTokens - cached
  return (uncached / 1_000_000) * price.inputPerMTok + (cached / 1_000_000) * (price.cachedInputPerMTok ?? 0) + (usage.outputTokens / 1_000_000) * price.outputPerMTok
}
