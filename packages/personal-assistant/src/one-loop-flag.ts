/**
 * Pure logic backing PersonalAssistant's ASSISTANT_ONE_LOOP handling — split out so it's
 * unit-testable in isolation, same pattern as control-plane-flag.ts (removed in
 * personal-assistant: Phase 4b/4c) and non-interactive-mode.ts's resolveNonInteractiveApprovalMode:
 * a module-level default resolved once from process.env, threaded as an injectable constructor
 * option so tests never touch real process.env.
 *
 * Backs plans/harness_d2_one_loop_rewire_plan.html's R2 phase: the harness-driven proposer that
 * lets HarnessRuntime's driveMainLoop actually call AgentLoop's tool-calling machinery once per
 * main-loop iteration, instead of receiving an already-finished draftReply after the fact. Unlike
 * ASSISTANT_CONTROL_PLANE, this flag is NOT a rollout-proves-a-no-op flag from day one — R2 lands
 * it default OFF, and R3/R4 build the rest of the wiring behind it before R5 flips the default and
 * removes it, mirroring ASSISTANT_CONTROL_PLANE's own shape without resurrecting its file.
 *
 * 'enabled': HarnessBridge.run() swaps in a real harness-driven proposer (built from
 * AgentLoop.createHarnessProposer) as the 'default' toolExecutor, when the caller supplies one.
 * 'disabled' (the default, for the whole R2-R4 rollout window): today's behavior, byte-for-byte —
 * toolExecutors.default always resolves to `() => draftReply`. An unrecognized value is ignored
 * (falls back to the default) with a startup warning, same typo-tolerance-with-a-warning
 * convention resolveControlPlaneMode/resolveNonInteractiveApprovalMode used, since a
 * silently-misread flag here is safety-relevant.
 */
export type OneLoopMode = 'enabled' | 'disabled'

export const DEFAULT_ONE_LOOP_MODE: OneLoopMode = 'disabled'

export function resolveOneLoopMode(env: NodeJS.ProcessEnv): OneLoopMode {
  const raw = env.ASSISTANT_ONE_LOOP
  if (raw === undefined) return DEFAULT_ONE_LOOP_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ASSISTANT_ONE_LOOP="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_ONE_LOOP_MODE}).`)
  return DEFAULT_ONE_LOOP_MODE
}
