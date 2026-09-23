/**
 * Pure logic backing the hierarchical-goal-tree mechanism's Tier 0/1 gate — the
 * `LiveSteeringChannel` producer/routing split (Phase 3), the Scope×Urgency classifier and
 * `GoalGraphRecord` status writes (Phase 4) — see
 * plans/hierarchical_goal_tree_and_steering_plan.html. Split out so it's unit-testable in
 * isolation, the same pattern as one-loop-flag.ts/ask-mode-flag.ts/plan-mode-flag.ts.
 *
 * Unlike those three, this is deliberately **not** threaded through `AssistantConfig` yet — the
 * plan's own Phase 8 is where `goalGraphMode` becomes a real config field with `/config set`
 * support, a `VITE_ASSISTANT_GOAL_GRAPH` build-time line in chat-ui's browser-config.ts, and
 * flag-chain resolution tests. Until then this mirrors the Trajectory Supervisor's own S0
 * discipline ("flag defined, default OFF, read nowhere yet except a single guard stub"): cli.ts
 * reads it directly from `process.env.ASSISTANT_GOAL_GRAPH` (via `RunCliOptions.goalGraphMode`,
 * not `AssistantConfig`) and chat-ui's App.tsx reads it directly from
 * `import.meta.env.VITE_ASSISTANT_GOAL_GRAPH`, both via `normalizeGoalGraphMode` below.
 *
 * Default OFF ('disabled'): the CLI's `dispatchQueue` and chat-ui's busy-disables-composer
 * behavior stay byte-identical to today (INV-43) — a message sent while a turn is running keeps
 * waiting on `dispatchQueue` / the disabled composer, exactly as before. 'enabled' routes an
 * in-flight message into a `LiveSteeringChannel` instead, but Phase 3 alone has no consumer for
 * it inside the harness's iteration loop yet (Phase 4 wires that in) — so even with the flag on,
 * this is inert-by-construction beyond the CLI/chat-ui routing split itself.
 */
export type GoalGraphMode = 'enabled' | 'disabled'

export const DEFAULT_GOAL_GRAPH_MODE: GoalGraphMode = 'disabled'

/**
 * Shared by cli.ts (reads `process.env.ASSISTANT_GOAL_GRAPH`) and chat-ui's App.tsx (reads Vite's
 * `import.meta.env.VITE_ASSISTANT_GOAL_GRAPH`, which has no `process` to hand a
 * `NodeJS.ProcessEnv` to). An unset or empty value falls back to the default silently; an
 * unrecognized non-empty value falls back with a startup warning naming `varName`, the same
 * typo-tolerance-with-a-warning convention normalizeOneLoopMode/normalizeAskMode/normalizePlanMode
 * use.
 */
export function normalizeGoalGraphMode(raw: string | undefined, varName = 'ASSISTANT_GOAL_GRAPH'): GoalGraphMode {
  if (raw === undefined || raw === '') return DEFAULT_GOAL_GRAPH_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_GOAL_GRAPH_MODE}).`)
  return DEFAULT_GOAL_GRAPH_MODE
}

export function resolveGoalGraphMode(env: NodeJS.ProcessEnv): GoalGraphMode {
  return normalizeGoalGraphMode(env.ASSISTANT_GOAL_GRAPH)
}
