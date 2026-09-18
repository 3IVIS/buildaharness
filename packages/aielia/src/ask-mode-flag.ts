/**
 * Pure logic backing PersonalAssistant's ASSISTANT_ASK_MODE handling — split out so it's
 * unit-testable in isolation, mirroring one-loop-flag.ts's exact shape (module-level default,
 * an injectable resolver so tests never touch real process.env).
 *
 * Q2 of plans/ask_question_and_plan_mode_plan.html: the "global flag" control point (tier 1 of
 * Q1's three-tier INV-29 resolution) for the batched-questions ask-question mechanism, resolved
 * at this package's boundary and handed to `@buildaharness/harness`'s `resolveAskMode()` as
 * `globalEnabled`. 'disabled' (the default, for the whole rollout window, per Q1's
 * `DEFAULT_ASK_MODE`) means every escalation stays on today's plain `escalated`/`reply: null`
 * path — AskClarificationService is never reached. 'enabled' lets a populated
 * `EscalationHalt.blocker.questions` promote to `needs_clarification` instead.
 */
export type AskMode = 'enabled' | 'disabled'

export const DEFAULT_ASK_MODE: AskMode = 'disabled'

/**
 * Value-level resolver, shared by every surface: `resolveAskMode` (CLI, reads
 * `process.env.ASSISTANT_ASK_MODE`) and chat-ui's `envOverridesFromImportMetaEnv` (browser
 * build, reads Vite's `import.meta.env.VITE_ASSISTANT_ASK_MODE`). An unset or empty value falls
 * back to the default silently; an unrecognized non-empty value falls back with a startup
 * warning naming `varName` — same typo-tolerance-with-a-warning convention
 * `normalizeOneLoopMode` uses, since a silently-misread flag here is safety-relevant.
 */
export function normalizeAskMode(raw: string | undefined, varName = 'ASSISTANT_ASK_MODE'): AskMode {
  if (raw === undefined || raw === '') return DEFAULT_ASK_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_ASK_MODE}).`)
  return DEFAULT_ASK_MODE
}

export function resolveAskMode(env: NodeJS.ProcessEnv): AskMode {
  return normalizeAskMode(env.ASSISTANT_ASK_MODE)
}
