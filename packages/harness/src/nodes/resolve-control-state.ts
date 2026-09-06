import type { WorldModel } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { ControlState, type BlockEntry } from '../state/control-state.js'
import { assertNormalised, normalise, DimensionType } from '../normalise.js'
import { computeElevationFactor } from '../generation-id.js'
import type { ReviewerVerdict } from './reviewer-pass.js'
import {
  CRITICAL_THRESHOLD,
  CAUTION_THRESHOLD,
  RECOVERY_ACTION_DEPENDENCIES,
  DIMENSION_RECOVERY,
  CONFIDENCE_DIMENSIONS,
  RISK_DIMENSIONS,
  DEP_CLASS_GAP_NOTE_PREFIX,
  MODEL_PROVENANCE_NOTE_PREFIX,
} from '../_core-generated.js'

// CRITICAL_THRESHOLD, CAUTION_THRESHOLD, RECOVERY_ACTION_DEPENDENCIES,
// DIMENSION_RECOVERY, CONFIDENCE_DIMENSIONS, RISK_DIMENSIONS and
// DEP_CLASS_GAP_NOTE_PREFIX are generated from spec/harness-core.json into
// _core-generated.ts (Phase C1 — ADR-004, shared semantic core), the single
// source of truth shared with adapter/harness/control_state.py. The resolver
// ALGORITHM below stays hand-mirrored with control_state.py, guarded by
// scripts/harness-conformance/compare.mjs.
//
// Re-exported so existing importers (harness-runtime.ts, nodes/initialize.ts)
// keep resolving them from this module.
export { CRITICAL_THRESHOLD, CAUTION_THRESHOLD, RECOVERY_ACTION_DEPENDENCIES }

function buildRecoveryActionGraph(blockMask: BlockEntry[]): Map<string, Set<string>> {
  const blockedDims = new Set(blockMask.map(e => e.dimension))
  const graph = new Map<string, Set<string>>()
  for (const entry of blockMask) {
    const required = RECOVERY_ACTION_DEPENDENCIES[entry.recovery_action_class] ?? []
    const blockedDeps = new Set(required.filter(d => blockedDims.has(d)))
    graph.set(entry.dimension, blockedDeps)
  }
  return graph
}

function hasCycle(graph: Map<string, Set<string>>): boolean {
  const visited = new Set<string>()
  const recStack = new Set<string>()

  function dfs(node: string): boolean {
    visited.add(node)
    recStack.add(node)
    for (const neighbor of graph.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true
      } else if (recStack.has(neighbor)) {
        return true
      }
    }
    recStack.delete(node)
    return false
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true
    }
  }
  return false
}

function detectDeadlock(blockMask: BlockEntry[]): boolean {
  const graph = buildRecoveryActionGraph(blockMask)
  return hasCycle(graph)
}

/**
 * INV-11: fill a deterministic-default DimensionProvenance for every sub-dimension name
 * that has no entry yet, so no dimension reaches the resolver un-provenanced. Mirrors
 * control_state.py's _ensure_provenance().
 */
function ensureProvenance(diagnostics: Diagnostics, subDims: Array<[string, number]>): void {
  for (const [name] of subDims) {
    if (!(name in diagnostics.provenance)) {
      diagnostics.provenance[name] = { source: 'deterministic', calibrated: false, evidence_ids: [] }
    }
  }
}

/**
 * INV-11 annotation (criticism001 #3, ADR-004): when a Tier-1/2 block is driven by a
 * sub-dimension whose value is an uncalibrated model estimate, say so in notes[]. Annotation
 * only — the resolver does NOT dampen the block (that behaviour change is left behind the
 * Phase C flag per ADR-004). Mirrors control_state.py's _attach_provenance_notes() exactly.
 */
function attachProvenanceNotes(cs: ControlState, notes: string[], diagnostics: Diagnostics): void {
  const flagged = cs.block_mask
    .map(e => e.dimension)
    .filter(dim => {
      const p = diagnostics.provenance[dim]
      return p !== undefined && p.source === 'model' && !p.calibrated
    })
    .sort()
  for (const dim of flagged) {
    notes.push(`${MODEL_PROVENANCE_NOTE_PREFIX}${dim}`)
  }
}

function extractSubDimensions(diagnostics: Diagnostics): Array<[string, number]> {
  const { belief_health: bh, coverage_health: ch, verification_health: vh, execution_health: eh } = diagnostics
  return [
    ['belief_freshness', bh.freshness],
    ['belief_consistency', bh.consistency],
    ['belief_support', bh.support],
    ['symptom_coverage', ch.symptom_coverage],
    ['explanation_coverage', ch.explanation_coverage],
    ['verification_strength', vh.strength],
    ['verification_feasibility', vh.feasibility],
    ['progress_rate', eh.progress_rate],
    // failure_recurrence and oscillation_score: 0=healthy, so invert for threshold logic
    ['failure_recurrence', 1 - eh.failure_recurrence],
    ['oscillation_score', 1 - eh.oscillation_score],
  ]
}

// CONFIDENCE_DIMENSIONS / RISK_DIMENSIONS: disjoint sub-dimension pools
// risk_estimate/confidence_estimate are computed from — imported from the
// generated core above (mirrors control_state.py exactly).

function computeRiskAndConfidenceEstimates(subDims: Array<[string, number]>): { risk_estimate: number; confidence_estimate: number } {
  const confidenceValues: number[] = []
  const riskPoolValues: number[] = []
  for (const [name, normValue] of subDims) {
    if (CONFIDENCE_DIMENSIONS.has(name)) confidenceValues.push(normValue)
    else if (RISK_DIMENSIONS.has(name)) riskPoolValues.push(normValue)
  }
  const confidence_estimate = confidenceValues.length > 0
    ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
    : 1.0
  const riskPoolHealth = riskPoolValues.length > 0
    ? riskPoolValues.reduce((a, b) => a + b, 0) / riskPoolValues.length
    : 1.0
  const risk_estimate = Math.max(0.0, Math.min(1.0, 1.0 - riskPoolHealth))
  return { risk_estimate, confidence_estimate }
}

/**
 * A-4 (ADR-003 authority map): a pending reviewer finding of severity >= MEDIUM forces
 * execution_mode to at least CAUTIOUS — advisory only, never DENY; the resolver's own
 * tiers still own blocking (Phase I, INV-18). Called once, at resolveControlState's single
 * exit point below, after whichever tier fired has already set permission/execution_mode,
 * so it can only raise execution_mode from NORMAL to CAUTIOUS, never lower a tier's own
 * RECOVERY back down and never touch permission. Mirrors control_state.py's
 * _apply_pending_reviewer_verdict() exactly. The caller (harness-runtime.ts's
 * resolveAndStamp) owns the one-shot consume-then-clear.
 */
function applyPendingReviewerVerdict(cs: ControlState, notes: string[], verdict: ReviewerVerdict | null | undefined): void {
  if (verdict == null) return
  if (verdict.severity !== 'MEDIUM' && verdict.severity !== 'HIGH') return
  notes.push(`Pending reviewer verdict (${verdict.lens}, ${verdict.severity}): ${verdict.summary}`)
  if (cs.execution_mode === 'NORMAL') {
    cs.execution_mode = 'CAUTIOUS'
  }
}

export function resolveControlState(
  diagnostics: Diagnostics,
  worldModel: WorldModel,
  failureDiagnostics: FailureDiagnostics,
  _step?: number,
  pendingReviewerVerdict?: ReviewerVerdict | null,
): ControlState {
  assertNormalised(diagnostics.belief_health.freshness, 'belief_health.freshness')
  assertNormalised(diagnostics.belief_health.consistency, 'belief_health.consistency')
  assertNormalised(diagnostics.belief_health.support, 'belief_health.support')
  assertNormalised(diagnostics.coverage_health.symptom_coverage, 'coverage_health.symptom_coverage')
  assertNormalised(diagnostics.coverage_health.explanation_coverage, 'coverage_health.explanation_coverage')
  assertNormalised(diagnostics.verification_health.strength, 'verification_health.strength')
  assertNormalised(diagnostics.verification_health.feasibility, 'verification_health.feasibility')
  assertNormalised(diagnostics.execution_health.progress_rate, 'execution_health.progress_rate')
  assertNormalised(diagnostics.execution_health.failure_recurrence, 'execution_health.failure_recurrence')
  assertNormalised(diagnostics.execution_health.oscillation_score, 'execution_health.oscillation_score')

  const cs = new ControlState()
  const notes: string[] = []

  // Computed once, attached regardless of which tier fires below — continuous and additive,
  // so they never influence which tier fires (mirrors control_state.py's own invariant here).
  const subDimsForEstimate = extractSubDimensions(diagnostics)
  // INV-11: every sub-dimension reaching the resolver carries provenance. Any name not
  // stamped by a producer (today: all ten — the health values are computed
  // deterministically from world-model / evidence counts) is filled with the deterministic
  // default here, before any tier reads it.
  ensureProvenance(diagnostics, subDimsForEstimate)
  const estimates = computeRiskAndConfidenceEstimates(subDimsForEstimate)
  cs.risk_estimate = estimates.risk_estimate
  cs.confidence_estimate = estimates.confidence_estimate
  const subDims = subDimsForEstimate

  // TIER 1: any SYSTEM_BREAKING contradiction → BLOCKED; TIER 2's own checks below are
  // skipped by the guard on cs.permission.
  if (worldModel.contradictions.some(c => c.severity === 'SYSTEM_BREAKING')) {
    cs.permission = 'DENY'
    cs.execution_mode = 'RECOVERY'
    cs.escalation = 'SYSTEM_BREAKING'
    cs.escalation_reason = 'SYSTEM_BREAKING_CONTRADICTION'
    cs.block_mask = [{
      dimension: 'world_model_integrity',
      value: 0.0,
      recovery_action_class: 'consistency_repair',
    }]
  }

  // TIER 2: each sub-dim < CRITICAL_THRESHOLD gets its own BlockEntry (individual dimension
  // granularity) — only evaluated if Tier 1 hasn't already denied.
  if (cs.permission !== 'DENY') {
    const blockMask: BlockEntry[] = []
    for (const [dimName, normValue] of subDims) {
      if (normValue < CRITICAL_THRESHOLD) {
        blockMask.push({
          dimension: dimName,
          value: normValue,
          recovery_action_class: DIMENSION_RECOVERY[dimName] ?? 'consistency_repair',
        })
      }
    }

    if (blockMask.length > 0) {
      cs.block_mask = blockMask
      cs.permission = 'DENY'
      cs.execution_mode = 'RECOVERY'
      if (detectDeadlock(blockMask)) {
        cs.escalation = 'HUMAN_REQUIRED'
        cs.escalation_reason = 'HUMAN_REQUIRED'
      }
    }
  }

  // TIERS 3 & 4: only matter if nothing above has already denied.
  if (cs.permission !== 'DENY') {
    // TIER 3: coverage gaps in [CRITICAL_THRESHOLD, CAUTION_THRESHOLD) → CAUTIOUS
    const { symptom_coverage, explanation_coverage } = diagnostics.coverage_health
    if (
      (symptom_coverage >= CRITICAL_THRESHOLD && symptom_coverage < CAUTION_THRESHOLD) ||
      (explanation_coverage >= CRITICAL_THRESHOLD && explanation_coverage < CAUTION_THRESHOLD)
    ) {
      cs.execution_mode = 'CAUTIOUS'
      if (symptom_coverage >= CRITICAL_THRESHOLD && symptom_coverage < CAUTION_THRESHOLD) {
        notes.push(`Coverage gap in symptom_coverage (${symptom_coverage.toFixed(3)}): exploration actions allowed`)
      }
      if (explanation_coverage >= CRITICAL_THRESHOLD && explanation_coverage < CAUTION_THRESHOLD) {
        notes.push(`Coverage gap in explanation_coverage (${explanation_coverage.toFixed(3)}): exploration actions allowed`)
      }
    }

    // TIER 4: proportional caution elevation from all sub-dimensions + matched pattern confidence
    const allSubDimValues = subDims.map(([, v]) => v)
    let elevationFactor = computeElevationFactor(allSubDimValues)

    const matchedPattern = failureDiagnostics.matched_pattern
    if (matchedPattern !== null) {
      const patternConfidence = normalise(matchedPattern.confidence, DimensionType.ratio)
      elevationFactor = elevationFactor * 0.8 + patternConfidence * 0.2
    }

    if (elevationFactor > 0.05 && cs.execution_mode === 'NORMAL') {
      cs.execution_mode = 'CAUTIOUS'
    }
  }

  // TIER 5: NORMAL — implicit; ControlState defaults to permission=ALLOW/execution_mode=NORMAL

  // ── Single exit point ──────────────────────────────────────────────────────
  // dep_class_gap_annotation attached to notes[] only — NOT evaluated in any tier (INV-07)
  if (diagnostics.dep_class_gap_annotation) {
    notes.push(`${DEP_CLASS_GAP_NOTE_PREFIX}${diagnostics.dep_class_gap_annotation}`)
  }

  attachProvenanceNotes(cs, notes, diagnostics)
  applyPendingReviewerVerdict(cs, notes, pendingReviewerVerdict)
  cs.notes = notes
  cs.generation_id = worldModel.generation_id
  return cs
}
