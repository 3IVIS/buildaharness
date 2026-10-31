import { TokenUsage } from '@buildaharness/runtime';
/**
 * Adds a static-table cost estimate to a turn's usage. claude-cli (total_cost_usd) and openrouter
 * (usage.cost) report a real dollar cost, and a real `costUsd` is never overwritten; every other
 * case (proxy, anthropic, openai: token counts only) gets an approximate estimate, see model-pricing.ts.
 * The model is `model`, else the backend's own default, else the Anthropic default. One function for the
 * CLI's /cost, the apps' cost line and the spend cap, so they cannot disagree.
 */
export declare function withCostEstimate(usage: TokenUsage, { backend, model }: {
    backend?: string;
    model?: string;
}): TokenUsage;
