import {
  WorldModel,
  EvidenceStore,
  Diagnostics,
  FailureDiagnostics,
  ControlState,
  gatherEvidence,
  applyToolReliability,
  updateWorldModel,
  resolveControlState,
  normalise,
  DimensionType,
  type ToolAvailability,
} from '@buildaharness/harness'

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
  readonly evidenceStore: EvidenceStore
  readonly worldModel: WorldModel
  readonly diagnostics: Diagnostics
  readonly failureDiagnostics: FailureDiagnostics
  controlState: ControlState
  /** How many times each identical call has already come back negative or failed this turn (see `ToolOutcome.callKey`). */
  readonly unproductiveCalls: Map<string, number>
  /**
   * EVAL-ONLY ablation (see `controlStateToolPolicyEnabled`): when true this state stays at its
   * default ALLOW/NORMAL — `recordToolOutcome` still records evidence but never re-resolves, and
   * agent-loop does not fold the harness's per-iteration state in — so tool policy never sees a DENY.
   */
  readonly pinNormal?: boolean
}

/**
 * `AUDIT_CONTROL_STATE_TOOL_POLICY` gate — feature-value audit, EVAL-ONLY: default **ON** (unset /
 * empty / truthy keeps today's behaviour). Only the benchmark's `controlStateToolPolicyOff` and
 * `controlStateOff` arms set a falsy value (`0` / `false` / `off` / `no` / `disabled`), which pins the
 * ControlState that `evaluateToolPolicy` reads at ALLOW/NORMAL. Read at exactly one call site
 * (`createControlPlaneState`); the harness's own gate is a separate switch (`AUDIT_CONTROL_STATE_GATE`).
 */
export function controlStateToolPolicyEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_CONTROL_STATE_TOOL_POLICY ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * `AUDIT_CONTROL_STATE_GATE` gate — feature-value audit, EVAL-ONLY: default **ON**. Only the
 * `controlStateOff` arm sets a falsy value, which makes `HarnessBridge.run` pass
 * `skipControlState: true` to HarnessRuntime so `resolveAndStamp` leaves the harness's own state at
 * ALLOW/NORMAL (no gate BLOCK/ESCALATE, no reviewer-verdict CAUTIOUS). Read at one call site.
 */
export function controlStateGateEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_CONTROL_STATE_GATE ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * A fresh EvidenceStore defaults to an EMPTY tool_availability_manifest, which makes
 * gatherEvidence() silently no-op for every tool. Seed it with every tool name this turn's
 * config actually enables, so tool outcomes are never silently dropped.
 */
export function toolAvailabilityManifest(toolNames: string[]): Record<string, ToolAvailability> {
  return Object.fromEntries(toolNames.map((name) => [name, { available: true, fallback_tool: null }]))
}

export function createTurnControlPlaneState(toolNames: string[], opts: { pinNormal?: boolean } = {}): TurnControlPlaneState {
  return {
    ...(opts.pinNormal ? { pinNormal: true } : {}),
    evidenceStore: new EvidenceStore({ tool_availability_manifest: toolAvailabilityManifest(toolNames) }),
    worldModel: new WorldModel(),
    diagnostics: new Diagnostics(),
    failureDiagnostics: new FailureDiagnostics(),
    controlState: new ControlState(),
    unproductiveCalls: new Map(),
  }
}

/** Identical calls that came back negative before the next one counts as a retry. */
const UNPRODUCTIVE_REPEAT_FREE = 2

export interface ToolOutcome {
  toolName: string
  ok: boolean
  /**
   * The call worked and the answer was "not there" (a missing file). Not a fault, so it does not count as a failure —
   * unless the identical call has already come back negative twice (`callKey`), which is a retry of a known answer.
   */
  negative?: boolean
  /** Identifies the call (tool + arguments) so repeats of an already-negative or failed call can be recognised. */
  callKey?: string
  /** Short, human-readable — never the full resultText (can be large/untrusted). */
  summary: string
}

/**
 * How much a ControlState restricts tool use, ranked by exactly what tool-policy.ts's
 * evaluateToolPolicy() gates on: a DENY permission is the hardest stop, then a
 * HUMAN_REQUIRED / SYSTEM_BREAKING escalation, then a non-NORMAL execution_mode, then nothing.
 */
function controlStateGateSeverity(cs: ControlState): number {
  if (cs.permission === 'DENY') return 3
  if (cs.escalation === 'HUMAN_REQUIRED' || cs.escalation === 'SYSTEM_BREAKING') return 2
  if (cs.execution_mode === 'CAUTIOUS' || cs.execution_mode === 'RECOVERY') return 1
  return 0
}

/**
 * The more tool-restrictive of two ControlStates (ties → `a`). A harness-driven proposer must
 * honor BOTH the harness's own per-iteration ControlState AND the turn-local one accumulated
 * from this turn's prior tool-call outcomes (via recordToolOutcome) — neither may silently
 * downgrade the other. Overwriting one with the other (which the one-loop proposer used to do)
 * loses whichever restriction the discarded side carried; this keeps the stricter one.
 */
export function moreRestrictiveControlState(a: ControlState, b: ControlState): ControlState {
  return controlStateGateSeverity(b) > controlStateGateSeverity(a) ? b : a
}

/**
 * Feeds one tool call's outcome through the partial pipeline described in this file's own
 * top-of-file doc comment, mutates `state` in place, and returns the freshly-resolved
 * ControlState (also left on `state.controlState` for convenience).
 */
export function recordToolOutcome(state: TurnControlPlaneState, outcome: ToolOutcome): ControlState {
  // What counts toward the failure ratio. A real error always does. A negative answer ("no such file") is information,
  // so a probe of many different paths does not — but asking again for something the tool already said is not there is
  // a retry loop: the first UNPRODUCTIVE_REPEAT_FREE identical calls are free, the rest count.
  let repeatedNegative = false
  if (outcome.callKey && (outcome.negative === true || !outcome.ok)) {
    const seen = (state.unproductiveCalls.get(outcome.callKey) ?? 0) + 1
    state.unproductiveCalls.set(outcome.callKey, seen)
    repeatedNegative = outcome.negative === true && seen > UNPRODUCTIVE_REPEAT_FREE
  }
  const countsAsFailure = !outcome.ok || repeatedNegative
  const summary = repeatedNegative ? `${outcome.toolName} repeated an identical call that already found nothing` : outcome.summary

  const evidence = gatherEvidence(
    {
      id: `tool-${state.evidenceStore.observations.length}`,
      obs: summary,
      source: outcome.toolName,
      evidence_type: countsAsFailure ? 'SYSTEM_ERROR' : 'OBSERVATION',
    },
    state.evidenceStore,
  )

  if (evidence) {
    const capped = applyToolReliability(evidence, state.evidenceStore, state.diagnostics)
    updateWorldModel(capped, state.worldModel, state.diagnostics)
  }

  if (countsAsFailure) {
    state.failureDiagnostics.recordFailure({
      id: `tool-failure-${state.failureDiagnostics.failure_history.length}`,
      timestamp: new Date().toISOString(),
      failure_class: 'tool_call_failed',
      description: summary,
      context: { tool: outcome.toolName },
    })
  }
  // Same formula as update-diagnostics.ts's own execution_health.failure_recurrence — see this
  // file's top-of-file doc comment for why the rest of updateDiagnostics() is never called here.
  state.diagnostics.execution_health = {
    ...state.diagnostics.execution_health,
    failure_recurrence: normalise(Math.min(1, state.failureDiagnostics.failure_history.length / 10), DimensionType.ratio),
  }

  if (state.pinNormal) return state.controlState
  state.controlState = resolveControlState(state.diagnostics, state.worldModel, state.failureDiagnostics)
  return state.controlState
}
