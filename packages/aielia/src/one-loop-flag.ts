/**
 * Pure logic backing PersonalAssistant's ASSISTANT_ONE_LOOP handling — split out so it's
 * unit-testable in isolation, same pattern as control-plane-flag.ts (removed in
 * personal-assistant: Phase 4b/4c) and non-interactive-mode.ts's resolveNonInteractiveApprovalMode:
 * a module-level default resolved once from process.env, threaded as an injectable constructor
 * option so tests never touch real process.env.
 *
 * Backs plans/harness_d2_one_loop_rewire_plan.html's R2 phase: the harness-driven proposer that
 * lets HarnessRuntime's driveMainLoop actually call AgentLoop's tool-calling machinery once per
 * main-loop iteration, instead of receiving an already-finished draftReply after the fact. R2
 * landed it default OFF; R3/R4 built the rest of the wiring behind it; R5 gathered the rollout
 * evidence (Rule 2/Rule 6 differential clean, CLI live-verification both states, the chat-ui
 * flag OFF/ON parity matrix green under real headless Chromium) and flipped the default to
 * 'enabled' on 2026-09-06. The flag itself is kept for one more window as an escape hatch before
 * being removed (R5's final step), mirroring ASSISTANT_CONTROL_PLANE's own shape.
 *
 * 'enabled' (the default): HarnessBridge.run() swaps in a real harness-driven proposer (built
 * from AgentLoop.createHarnessProposer) as the 'default' toolExecutor, when the caller supplies
 * one — the harness's driveMainLoop drives the real tool calls one iteration at a time.
 * 'disabled': the pre-rewire behavior — toolExecutors.default always resolves to
 * `() => draftReply` (the tool loop runs to completion first, the harness sees the finished
 * reply). An unrecognized value is ignored (falls back to the default) with a startup warning,
 * same typo-tolerance-with-a-warning convention resolveControlPlaneMode/
 * resolveNonInteractiveApprovalMode used, since a silently-misread flag here is safety-relevant.
 */
export type OneLoopMode = 'enabled' | 'disabled'

export const DEFAULT_ONE_LOOP_MODE: OneLoopMode = 'enabled'

/**
 * Value-level resolver, shared by every surface: `resolveOneLoopMode` (CLI, reads
 * `process.env.ASSISTANT_ONE_LOOP`) and chat-ui's `envOverridesFromImportMetaEnv` (browser build,
 * reads Vite's `import.meta.env.VITE_ASSISTANT_ONE_LOOP`, which has no `process` to hand a
 * `NodeJS.ProcessEnv` to). An unset or empty value falls back to the default silently; an
 * unrecognized non-empty value falls back with a startup warning naming `varName`, the same
 * typo-tolerance-with-a-warning convention resolveControlPlaneMode/resolveNonInteractiveApprovalMode
 * use, since a silently-misread flag here is safety-relevant.
 */
export function normalizeOneLoopMode(raw: string | undefined, varName = 'ASSISTANT_ONE_LOOP'): OneLoopMode {
  if (raw === undefined || raw === '') return DEFAULT_ONE_LOOP_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_ONE_LOOP_MODE}).`)
  return DEFAULT_ONE_LOOP_MODE
}

export function resolveOneLoopMode(env: NodeJS.ProcessEnv): OneLoopMode {
  return normalizeOneLoopMode(env.ASSISTANT_ONE_LOOP)
}
