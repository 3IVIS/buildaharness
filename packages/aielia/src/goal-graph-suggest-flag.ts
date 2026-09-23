/**
 * Pure logic backing the hierarchical-goal-tree mechanism's Tier 1.5 gate — the next-step
 * proposer (Phase 6, `next-step-proposer.ts`) — see
 * plans/hierarchical_goal_tree_and_steering_plan.html. Split out into its own file/flag rather
 * than folded into `goal-graph-flag.ts`, matching this codebase's one-flag-per-file convention
 * (`one-loop-flag.ts`/`ask-mode-flag.ts`/`plan-mode-flag.ts`/`goal-graph-flag.ts`) and the plan's
 * own "Rollout discipline" resolution (2026-09-22): gated independently of `goalGraphMode` since a
 * regression in the next-step proposer shouldn't block Tier 0/1 (the steering channel, classifier,
 * persistent `GoalGraphRecord`).
 *
 * Same S0 discipline as `goal-graph-flag.ts`: deliberately **not** threaded through
 * `AssistantConfig` yet — the plan's own Phase 8 is where `goalGraphSuggestMode` becomes a real
 * config field with `/config set` support, a `VITE_ASSISTANT_GOAL_GRAPH_SUGGEST` build-time line
 * in chat-ui's browser-config.ts, and flag-chain resolution tests. Until then, any caller reads it
 * directly from `process.env.ASSISTANT_GOAL_GRAPH_SUGGEST` / `import.meta.env` via
 * `normalizeGoalGraphSuggestMode` below — mirroring `normalizeGoalGraphMode` exactly.
 *
 * Default OFF ('disabled'): `next-step-proposer.ts`'s `proposeNextSteps()` returns `[]` without
 * making any LLM call, so a flag-off session sees zero behavior change (INV-43).
 */
export type GoalGraphSuggestMode = 'enabled' | 'disabled'

export const DEFAULT_GOAL_GRAPH_SUGGEST_MODE: GoalGraphSuggestMode = 'disabled'

/**
 * Same signature/typo-tolerance-with-a-warning convention as `normalizeGoalGraphMode`: an unset or
 * empty value falls back to the default silently, an unrecognized non-empty value falls back with
 * a startup warning naming `varName`.
 */
export function normalizeGoalGraphSuggestMode(raw: string | undefined, varName = 'ASSISTANT_GOAL_GRAPH_SUGGEST'): GoalGraphSuggestMode {
  if (raw === undefined || raw === '') return DEFAULT_GOAL_GRAPH_SUGGEST_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_GOAL_GRAPH_SUGGEST_MODE}).`)
  return DEFAULT_GOAL_GRAPH_SUGGEST_MODE
}

export function resolveGoalGraphSuggestMode(env: NodeJS.ProcessEnv): GoalGraphSuggestMode {
  return normalizeGoalGraphSuggestMode(env.ASSISTANT_GOAL_GRAPH_SUGGEST)
}
