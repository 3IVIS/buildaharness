/**
 * Cross-turn, cross-session spend enforcement — the review's §5.2 finding was that `/cost`
 * reports usage but nothing ever refuses a turn over it. Pure math/formatting only; PersonalAssistant
 * (assistant.ts) owns the actual persisted SpendState and calls checkSpendCap() once per turn,
 * before any LLM call for that turn is made (see assistant.ts's turn() wrapper).
 */
export interface SpendCapConfig {
    /** Undefined = unbounded, today's default behavior. */
    sessionCostLimitUsd?: number;
    /**
     * Optional secondary ceiling on completed turns this session (not raw internal LLM call
     * count — a single turn can make several real LLM calls of its own, e.g. decomposition +
     * tool-loop round trips, and none of those sub-calls can trigger a mid-turn refusal per
     * checkSpendCap's "pre-turn only" contract, so counting at that finer grain would have
     * nothing to enforce against). Named sessionCallLimit to match the review's own "dollar/call
     * ceiling" framing (§11).
     */
    sessionCallLimit?: number;
}
export interface SpendState {
    cumulativeCostUsd: number;
    cumulativeCalls: number;
    /** Tracked alongside cumulativeCostUsd (same cross-turn, cross-session lifetime) so /cost's
     * token tally and its dollar/ceiling figures always describe the same scope — previously the
     * token counts lived only in cli.ts's in-process `sessionUsage`, which resets on /new (and on
     * every fresh process) while this store does not, producing a "0 in / 0 out tokens" line next
     * to a real nonzero dollar cost once any turn had run before the current /new. */
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
}
export declare const EMPTY_SPEND_STATE: SpendState;
export type SpendCapCheck = {
    allowed: true;
} | {
    allowed: false;
    reason: string;
};
/** Called once at the start of turn(), before any LLM call for that turn is made. A turn already in flight is never interrupted mid-turn. */
export declare function checkSpendCap(state: SpendState, config: SpendCapConfig): SpendCapCheck;
/** Shared by /status and /cost (cli.ts) so the ceiling reads the same way in both places — undefined when no ceiling is configured, so callers can omit the line entirely rather than showing a meaningless "N% of nothing". */
export declare function formatSpendCapStatus(state: SpendState, config: SpendCapConfig): string | undefined;
