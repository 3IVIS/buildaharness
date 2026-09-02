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
 * Phase 4c of plans/harness_and_assistant_architecture_remediation_plan.html — a live, per-turn
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
}

/**
 * A fresh EvidenceStore defaults to an EMPTY tool_availability_manifest, which makes
 * gatherEvidence() silently no-op for every tool. Seed it with every tool name this turn's
 * config actually enables, so tool outcomes are never silently dropped.
 */
export function toolAvailabilityManifest(toolNames: string[]): Record<string, ToolAvailability> {
  return Object.fromEntries(toolNames.map((name) => [name, { available: true, fallback_tool: null }]))
}

export function createTurnControlPlaneState(toolNames: string[]): TurnControlPlaneState {
  return {
    evidenceStore: new EvidenceStore({ tool_availability_manifest: toolAvailabilityManifest(toolNames) }),
    worldModel: new WorldModel(),
    diagnostics: new Diagnostics(),
    failureDiagnostics: new FailureDiagnostics(),
    controlState: new ControlState(),
  }
}

export interface ToolOutcome {
  toolName: string
  ok: boolean
  /** Short, human-readable — never the full resultText (can be large/untrusted). */
  summary: string
}

/**
 * Feeds one tool call's outcome through the partial pipeline described in this file's own
 * top-of-file doc comment, mutates `state` in place, and returns the freshly-resolved
 * ControlState (also left on `state.controlState` for convenience).
 */
export function recordToolOutcome(state: TurnControlPlaneState, outcome: ToolOutcome): ControlState {
  const evidence = gatherEvidence(
    {
      id: `tool-${state.evidenceStore.observations.length}`,
      obs: outcome.summary,
      source: outcome.toolName,
      evidence_type: outcome.ok ? 'OBSERVATION' : 'SYSTEM_ERROR',
    },
    state.evidenceStore,
  )

  if (evidence) {
    const capped = applyToolReliability(evidence, state.evidenceStore, state.diagnostics)
    updateWorldModel(capped, state.worldModel, state.diagnostics)
  }

  if (!outcome.ok) {
    state.failureDiagnostics.recordFailure({
      id: `tool-failure-${state.failureDiagnostics.failure_history.length}`,
      timestamp: new Date().toISOString(),
      failure_class: 'tool_call_failed',
      description: outcome.summary,
      context: { tool: outcome.toolName },
    })
  }
  // Same formula as update-diagnostics.ts's own execution_health.failure_recurrence — see this
  // file's top-of-file doc comment for why the rest of updateDiagnostics() is never called here.
  state.diagnostics.execution_health = {
    ...state.diagnostics.execution_health,
    failure_recurrence: normalise(Math.min(1, state.failureDiagnostics.failure_history.length / 10), DimensionType.ratio),
  }

  state.controlState = resolveControlState(state.diagnostics, state.worldModel, state.failureDiagnostics)
  return state.controlState
}
