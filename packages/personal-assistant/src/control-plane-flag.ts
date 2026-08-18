/**
 * Pure logic backing PersonalAssistant's ASSISTANT_CONTROL_PLANE handling — split out so it's
 * unit-testable in isolation, same pattern as non-interactive-mode.ts's
 * resolveNonInteractiveApprovalMode (module-level default resolved once from process.env,
 * threaded as an injectable constructor option so tests never touch real process.env).
 *
 * Per the user's own decision recorded in
 * plans/harness_and_assistant_architecture_remediation_plan.html's Phase 4 section: this flag
 * exists only to prove flag-OFF is a true no-op during rollout of Phase 4's ExecutionMode/
 * ToolPolicy control-plane wiring. It is not intended as a permanent dual-path — once the
 * flag-off no-op test and the differential A/B corpus are green, the default flips to enabled and
 * the flag is removed shortly after, not kept indefinitely.
 *
 * 'enabled': ExecutionMode is computed and traced every turn, and ToolPolicy is the authoritative
 * gate consulted before every non-approval-staged tool call (see runToolIterations). 'disabled'
 * (the explicit opt-out, for the rollout window only): today's pre-Phase-4 behavior, byte-for-byte
 * — ExecutionMode/ToolPolicy are never consulted. An unrecognized value is ignored (falls back to
 * the default) with a startup warning, same typo-tolerance-with-a-warning convention
 * resolveNonInteractiveApprovalMode uses, since a silently-misread flag here is safety-relevant.
 */
export type ControlPlaneMode = 'enabled' | 'disabled'

// Flipped to 'enabled' (2026-08-18) once this session's own safety net went green: the dedicated
// flag-off no-op tests, the differential A/B tests (ordinary tool-using turn and write_file
// staging produce byte-identical status/reply/sources/pendingActionKind under both modes), the
// full pre-existing packages/personal-assistant suite (903/903, zero regressions), and live CLI
// verification (benign turn, a HIGH-risk shell command still gated and declinable, a read-only
// web-search/fetch_url turn still executing and grounding its reply) — see
// plans/harness_and_assistant_architecture_remediation_plan.html's Phase 4 step note for the
// full account. 'disabled' remains available as an emergency rollback lever during the rest of
// the rollout window; per the user's own decision, the flag itself is expected to be removed
// once that window closes, not kept as a permanent dual-path.
export const DEFAULT_CONTROL_PLANE_MODE: ControlPlaneMode = 'enabled'

export function resolveControlPlaneMode(env: NodeJS.ProcessEnv): ControlPlaneMode {
  const raw = env.ASSISTANT_CONTROL_PLANE
  if (raw === undefined) return DEFAULT_CONTROL_PLANE_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ASSISTANT_CONTROL_PLANE="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_CONTROL_PLANE_MODE}).`)
  return DEFAULT_CONTROL_PLANE_MODE
}
