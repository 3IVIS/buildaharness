/**
 * Static, approximate per-model pricing — a fallback for every backend whose response carries
 * token counts but no dollar figure. Anthropic and OpenAI responses report tokens only; OpenRouter
 * (usage.cost) and the Claude CLI (total_cost_usd) report a real cost, which callers prefer over
 * this table. This table is NOT billing-accurate: it ignores batch pricing, long-context tiers and
 * any rate change since it was last updated — update the numbers below when published pricing changes.
 */
export interface ModelPriceUsd {
    inputPerMTok: number;
    outputPerMTok: number;
    /** Rate for input tokens served from the provider's prompt cache; absent = same as inputPerMTok. */
    cachedInputPerMTok?: number;
    /** Rate for input tokens written to the prompt cache; absent = same as inputPerMTok. */
    cacheWritePerMTok?: number;
}
/**
 * Returns undefined (rather than a misleading number) when the model is unset or not a recognized one — callers must not silently treat "no estimate" as "free".
 * `cachedInputTokens` follows OpenAI's convention (a subset of inputTokens, billed at the cached rate); it is ignored for models with no cached rate.
 */
export declare function estimateCostUsd(model: string | undefined, usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
}): number | undefined;
