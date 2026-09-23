/**
 * Pure logic backing the hierarchical-goal-tree mechanism's Tier 0/1 gate — the
 * `LiveSteeringChannel` producer/routing split (Phase 3), the Scope×Urgency classifier and
 * `GoalGraphRecord` status writes (Phase 4) — see
 * plans/hierarchical_goal_tree_and_steering_plan.html. Split out so it's unit-testable in
 * isolation, the same pattern as one-loop-flag.ts/ask-mode-flag.ts/plan-mode-flag.ts.
 *
 * As of Phase 8, threaded through `AssistantConfig` exactly like those three: `goalGraphMode` is a
 * real config field with `/config set` support, a `VITE_ASSISTANT_GOAL_GRAPH` build-time line in
 * chat-ui's browser-config.ts, and flag-chain resolution tests (cli-config.test.ts,
 * browser-config.test.ts). Before Phase 8 this mirrored the Trajectory Supervisor's own S0
 * discipline ("flag defined, default OFF, read nowhere yet except a single guard stub"): cli.ts
 * read it directly from `process.env.ASSISTANT_GOAL_GRAPH` via a `RunCliOptions.goalGraphMode`
 * field (not `AssistantConfig`) and chat-ui's App.tsx read it directly from a module-level
 * `import.meta.env.VITE_ASSISTANT_GOAL_GRAPH` constant — both now resolve through
 * `config.goalGraphMode` instead, via `cli-config.ts`'s `envOverridesFromProcessEnv` /
 * `browser-config.ts`'s `envOverridesFromImportMetaEnv`, both still ultimately calling
 * `normalizeGoalGraphMode` below.
 *
 * Default ON ('enabled') as of 2026-09-23 (before that OFF; the 3-seed benchmark vs the queue-behind-the-turn baseline was neutral on success at lower cost). 'disabled' is the escape hatch: the CLI's `dispatchQueue` and chat-ui's busy-disables-composer
 * behavior stay byte-identical to today (INV-43) — a message sent while a turn is running keeps
 * waiting on `dispatchQueue` / the disabled composer, exactly as before. 'enabled' routes an
 * in-flight message into a `LiveSteeringChannel` instead. This flag alone still has no consumer
 * for it inside the harness's iteration loop (Phase 4 wires that in via the scope×urgency
 * classifier) — see that phase's own notes for the actual reconciliation behavior.
 */
export type GoalGraphMode = 'enabled' | 'disabled'

export const DEFAULT_GOAL_GRAPH_MODE: GoalGraphMode = 'enabled'

/**
 * The single place a resolved `config.goalGraphMode` becomes a boolean. `AssistantConfig.goalGraphMode`
 * stays out of DEFAULT_CONFIG (undefined = "the package owns the default"), so every consumer must
 * fall back to DEFAULT_GOAL_GRAPH_MODE rather than compare `=== 'enabled'` against a possibly-undefined value.
 */
export function isGoalGraphEnabled(mode: GoalGraphMode | undefined): boolean {
  return (mode ?? DEFAULT_GOAL_GRAPH_MODE) === 'enabled'
}

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
