/**
 * Cross-turn, cross-session spend enforcement — the review's §5.2 finding was that `/cost`
 * reports usage but nothing ever refuses a turn over it. Pure math/formatting only; PersonalAssistant
 * (assistant.ts) owns the actual persisted SpendState and calls checkSpendCap() once per turn,
 * before any LLM call for that turn is made (see assistant.ts's turn() wrapper).
 */

export interface SpendCapConfig {
  /** Undefined = unbounded, today's default behavior. */
  sessionCostLimitUsd?: number
  /**
   * Optional secondary ceiling on completed turns this session (not raw internal LLM call
   * count — a single turn can make several real LLM calls of its own, e.g. decomposition +
   * tool-loop round trips, and none of those sub-calls can trigger a mid-turn refusal per
   * checkSpendCap's "pre-turn only" contract, so counting at that finer grain would have
   * nothing to enforce against). Named sessionCallLimit to match the review's own "dollar/call
   * ceiling" framing (§11).
   */
  sessionCallLimit?: number
}

export interface SpendState {
  cumulativeCostUsd: number
  cumulativeCalls: number
}

export const EMPTY_SPEND_STATE: SpendState = { cumulativeCostUsd: 0, cumulativeCalls: 0 }

export type SpendCapCheck = { allowed: true } | { allowed: false; reason: string }

/** Called once at the start of turn(), before any LLM call for that turn is made. A turn already in flight is never interrupted mid-turn. */
export function checkSpendCap(state: SpendState, config: SpendCapConfig): SpendCapCheck {
  if (config.sessionCostLimitUsd !== undefined && state.cumulativeCostUsd >= config.sessionCostLimitUsd) {
    return {
      allowed: false,
      reason: `Session cost ceiling reached: $${state.cumulativeCostUsd.toFixed(4)} spent, ceiling is $${config.sessionCostLimitUsd.toFixed(2)}. Raise it with "/config set sessionCostLimitUsd <amount>" to continue this session.`,
    }
  }
  if (config.sessionCallLimit !== undefined && state.cumulativeCalls >= config.sessionCallLimit) {
    return {
      allowed: false,
      reason: `Session turn-count ceiling reached: ${state.cumulativeCalls} turns completed, ceiling is ${config.sessionCallLimit}. Raise it with "/config set sessionCallLimit <count>" to continue this session.`,
    }
  }
  return { allowed: true }
}

/** Shared by /status and /cost (cli.ts) so the ceiling reads the same way in both places — undefined when no ceiling is configured, so callers can omit the line entirely rather than showing a meaningless "N% of nothing". */
export function formatSpendCapStatus(state: SpendState, config: SpendCapConfig): string | undefined {
  if (config.sessionCostLimitUsd === undefined && config.sessionCallLimit === undefined) return undefined
  const parts: string[] = []
  if (config.sessionCostLimitUsd !== undefined) {
    const pct = config.sessionCostLimitUsd > 0 ? Math.min(100, (state.cumulativeCostUsd / config.sessionCostLimitUsd) * 100) : 100
    parts.push(`$${state.cumulativeCostUsd.toFixed(4)} / $${config.sessionCostLimitUsd.toFixed(2)} (${pct.toFixed(0)}% of ceiling)`)
  }
  if (config.sessionCallLimit !== undefined) {
    parts.push(`${state.cumulativeCalls}/${config.sessionCallLimit} turns`)
  }
  return parts.join(', ')
}
