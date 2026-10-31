import { WorldModel, EvidenceStore, Diagnostics, FailureDiagnostics, ControlState, ToolAvailability } from '@buildaharness/harness';
/**
 * Phase 4c of the internal plan — a live, per-turn
 * harness ControlState, so tool-policy.ts's evaluateToolPolicy() can be given a real
 * controlState instead of the pre-evidence-baseline `undefined` every call site passed before
 * this phase. Deliberately builds on the fallback control-plane design (no packages/harness core
 * changes): composes the harness's own pure, already-exported node functions directly, never
 * touching HarnessRuntime's generator.
 *
 * DESIGN NOTE — why this never calls the generic updateDiagnostics() node: that function's
 * coverage_health.symptom_coverage is computed from HypothesisSet.active, which nothing in this
 * minimal tool-call-outcome-only pipeline ever populates (there's no hypothesis-generation/
 * task-graph engine backing it here). symptom_coverage would therefore read structurally as 0 —
 * below CRITICAL_THRESHOLD — the moment updateDiagnostics() ran, which would spuriously DENY
 * almost every second-or-later tool call in every tool-using turn, regardless of whether
 * anything actually failed. Verified against adapter-equivalent source
 * (update-diagnostics.ts:150-167, resolve-control-state.ts:96-97,174-178) before this file was
 * written. Instead: coverage_health/execution_health.{progress_rate,oscillation_score} are left
 * at their constructor-safe defaults (confirmed outside the CAUTIOUS band), and only
 * execution_health.failure_recurrence is hand-updated, using update-diagnostics.ts's own exact
 * formula. That crosses CRITICAL_THRESHOLD at 8+ same-turn tool failures — a real, honest bar,
 * not a hair-trigger. (Not exactly the 9 a back-of-envelope 1-in-10 reading suggests: at exactly
 * 8 failures, failure_recurrence is 0.8, and resolve-control-state.ts's own pre-existing
 * `1 - failure_recurrence` comparison evaluates to 0.19999999999999996 in IEEE754 double
 * arithmetic — a floating-point rounding quirk already present in that comparison, not
 * introduced here — landing just under CRITICAL_THRESHOLD (0.2) one failure earlier than exact
 * decimal math would suggest. See tool-control-plane.test.ts for the pinned boundary.)
 *
 * SCOPE BOUNDARY, explicit and deliberate: this state is turn-scoped and in-memory only. A
 * persisted resume path (e.g. resolvePendingBatchConfirmation's batch-approval round trip
 * through storage) does not carry a live ControlState across the gap — the original turn's
 * state is gone by the time a resume happens. Real, buildable future work; out of scope here.
 */
export interface TurnControlPlaneState {
    readonly evidenceStore: EvidenceStore;
    readonly worldModel: WorldModel;
    readonly diagnostics: Diagnostics;
    readonly failureDiagnostics: FailureDiagnostics;
    controlState: ControlState;
    /** How many times each identical call has already come back negative or failed this turn (see `ToolOutcome.callKey`). */
    readonly unproductiveCalls: Map<string, number>;
    /**
     * EVAL-ONLY ablation (see `controlStateToolPolicyEnabled`): when true this state stays at its
     * default ALLOW/NORMAL — `recordToolOutcome` still records evidence but never re-resolves, and
     * agent-loop does not fold the harness's per-iteration state in — so tool policy never sees a DENY.
     */
    readonly pinNormal?: boolean;
}
/**
 * `AUDIT_CONTROL_STATE_TOOL_POLICY` gate — feature-value audit, EVAL-ONLY: default **ON** (unset /
 * empty / truthy keeps today's behaviour). Only the benchmark's `controlStateToolPolicyOff` and
 * `controlStateOff` arms set a falsy value (`0` / `false` / `off` / `no` / `disabled`), which pins the
 * ControlState that `evaluateToolPolicy` reads at ALLOW/NORMAL. Read at exactly one call site
 * (`createControlPlaneState`); the harness's own gate is a separate switch (`AUDIT_CONTROL_STATE_GATE`).
 */
export declare function controlStateToolPolicyEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_CONTROL_STATE_GATE` gate — feature-value audit, EVAL-ONLY: default **ON**. Only the
 * `controlStateOff` arm sets a falsy value, which makes `HarnessBridge.run` pass
 * `skipControlState: true` to HarnessRuntime so `resolveAndStamp` leaves the harness's own state at
 * ALLOW/NORMAL (no gate BLOCK/ESCALATE, no reviewer-verdict CAUTIOUS). Read at one call site.
 */
export declare function controlStateGateEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * A fresh EvidenceStore defaults to an EMPTY tool_availability_manifest, which makes
 * gatherEvidence() silently no-op for every tool. Seed it with every tool name this turn's
 * config actually enables, so tool outcomes are never silently dropped.
 */
export declare function toolAvailabilityManifest(toolNames: string[]): Record<string, ToolAvailability>;
export declare function createTurnControlPlaneState(toolNames: string[], opts?: {
    pinNormal?: boolean;
}): TurnControlPlaneState;
export interface ToolOutcome {
    toolName: string;
    ok: boolean;
    /**
     * The call worked and the answer was "not there" (a missing file). Not a fault, so it does not count as a failure —
     * unless the identical call has already come back negative twice (`callKey`), which is a retry of a known answer.
     */
    negative?: boolean;
    /** Identifies the call (tool + arguments) so repeats of an already-negative or failed call can be recognised. */
    callKey?: string;
    /** Short, human-readable — never the full resultText (can be large/untrusted). */
    summary: string;
}
/**
 * The more tool-restrictive of two ControlStates (ties → `a`). A harness-driven proposer must
 * honor BOTH the harness's own per-iteration ControlState AND the turn-local one accumulated
 * from this turn's prior tool-call outcomes (via recordToolOutcome) — neither may silently
 * downgrade the other. Overwriting one with the other (which the one-loop proposer used to do)
 * loses whichever restriction the discarded side carried; this keeps the stricter one.
 */
export declare function moreRestrictiveControlState(a: ControlState, b: ControlState): ControlState;
/**
 * Feeds one tool call's outcome through the partial pipeline described in this file's own
 * top-of-file doc comment, mutates `state` in place, and returns the freshly-resolved
 * ControlState (also left on `state.controlState` for convenience).
 */
export declare function recordToolOutcome(state: TurnControlPlaneState, outcome: ToolOutcome): ControlState;
