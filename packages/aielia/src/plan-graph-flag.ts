/**
 * Pure logic backing the plan-graph visualization (read-only plan view on the CLI and desktop/web
 * surfaces) — see plans/plan_visualization_plan.html. Same pattern as goal-graph-flag.ts.
 *
 * Presentation only: the flag never changes a plan, the harness or any persisted state, so it is
 * deliberately NOT in LAYER_SETTINGS. 'disabled' (the default) leaves every surface byte-identical
 * to the behaviour before the feature existed (INV-43). `AssistantConfig.planGraphMode` stays out of
 * DEFAULT_CONFIG (undefined = "the package owns the default"), so consumers go through
 * `isPlanGraphEnabled` rather than comparing against a possibly-undefined value.
 */
export type PlanGraphMode = 'enabled' | 'disabled'

export const DEFAULT_PLAN_GRAPH_MODE: PlanGraphMode = 'disabled'

export function isPlanGraphEnabled(mode: PlanGraphMode | undefined): boolean {
  return (mode ?? DEFAULT_PLAN_GRAPH_MODE) === 'enabled'
}

/**
 * Shared by cli-config.ts (via `resolvePlanGraphMode`) and chat-ui's browser-config.ts (Vite's
 * `import.meta.env.VITE_ASSISTANT_PLAN_GRAPH`, which has no `process`). An unset or empty value
 * falls back silently; an unrecognized value falls back with a warning naming `varName`.
 */
export function normalizePlanGraphMode(raw: string | undefined, varName = 'ASSISTANT_PLAN_GRAPH'): PlanGraphMode {
  if (raw === undefined || raw === '') return DEFAULT_PLAN_GRAPH_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_PLAN_GRAPH_MODE}).`)
  return DEFAULT_PLAN_GRAPH_MODE
}

export function resolvePlanGraphMode(env: NodeJS.ProcessEnv): PlanGraphMode {
  return normalizePlanGraphMode(env.ASSISTANT_PLAN_GRAPH)
}
