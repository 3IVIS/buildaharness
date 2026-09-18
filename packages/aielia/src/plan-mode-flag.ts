/**
 * Pure logic backing PersonalAssistant's ASSISTANT_PLAN_MODE handling — split out so it's
 * unit-testable in isolation, mirroring one-loop-flag.ts/ask-mode-flag.ts's exact shape
 * (module-level default, an injectable resolver so tests never touch real process.env).
 *
 * P11 of plans/ask_question_and_plan_mode_plan.html — the rollout flag gating P1-P8's whole
 * plan-mode behavior change (exclusive drafting, mandatory approval, the generalized trigger,
 * auto-advance, the markdown/delegate/trust-mode extensions) behind one switch. 'legacy' (the
 * default, for the whole rollout window, per `DEFAULT_PLAN_MODE`): P3's judgment-based
 * auto-trigger (assistant.ts's `runTurn`, the one production call site that ever calls
 * `PersonalAssistant.enterPlanMode`) never fires, so `planMode.active` never becomes true for
 * real user traffic and the entire P1-P8/P10 apparatus downstream of it stays dormant by
 * construction — same "inert until its one entry point is reached" shape P1 itself already
 * documents for the pre-P3 window, and the same discipline the Trajectory Supervisor's flag
 * uses (a single call-site gate rather than scattering flag checks through every downstream
 * consumer). Explicit/manual entry (`enterPlanMode` called directly by a test, or a future
 * `/plan enter`-style CLI verb) is deliberately left ungated by this flag, since it has no
 * production caller today independent of P3 (see `enterPlanMode`'s own doc comment) — there is
 * nothing for 'legacy' to preserve byte-identically there. 'gated' lets P3's auto-trigger run.
 */
export type PlanRolloutMode = 'gated' | 'legacy'

export const DEFAULT_PLAN_MODE: PlanRolloutMode = 'legacy'

/**
 * Value-level resolver, shared by every surface: `resolvePlanMode` (CLI, reads
 * `process.env.ASSISTANT_PLAN_MODE`) and chat-ui's `envOverridesFromImportMetaEnv` (browser
 * build, reads Vite's `import.meta.env.VITE_ASSISTANT_PLAN_MODE`). An unset or empty value
 * falls back to the default silently; an unrecognized non-empty value falls back with a
 * startup warning naming `varName` — same typo-tolerance-with-a-warning convention
 * normalizeOneLoopMode/normalizeAskMode use, since a silently-misread flag here is
 * safety-relevant (it decides whether real turns can auto-enter a durable, approval-gated
 * planning loop at all).
 */
export function normalizePlanMode(raw: string | undefined, varName = 'ASSISTANT_PLAN_MODE'): PlanRolloutMode {
  if (raw === undefined || raw === '') return DEFAULT_PLAN_MODE
  if (raw === 'gated' || raw === 'legacy') return raw
  console.error(`[warning] ${varName}="${raw}" is not "gated" or "legacy" — using the default (${DEFAULT_PLAN_MODE}).`)
  return DEFAULT_PLAN_MODE
}

export function resolvePlanMode(env: NodeJS.ProcessEnv): PlanRolloutMode {
  return normalizePlanMode(env.ASSISTANT_PLAN_MODE)
}
