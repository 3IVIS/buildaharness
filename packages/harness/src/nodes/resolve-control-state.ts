import type { WorldModel } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { ControlState } from '../state/control-state.js'
import { assertNormalised } from '../normalise.js'
import { computeElevationFactor } from '../generation-id.js'

export const CRITICAL_THRESHOLD = 0.2
export const HIGH_THRESHOLD = 0.5     // for symptom_coverage TIER 3
export const DIVERSITY_FLOOR = 0.3    // for explanation_coverage TIER 3
const CAUTION_THRESHOLD = 0.4
export const PATTERN_THRESHOLD = 0.6  // for matched_pattern.confidence TIER 4

export const HEALTH_DIMENSION_ACTION_CLASS: Record<string, string> = {
  belief_health: 'GATHER_EVIDENCE',
  coverage_health: 'EXPAND_SEARCH',
  verification_health: 'RUN_VERIFICATION',
  execution_health: 'EXECUTE_STEP',
}

// Cross-dimension only — self-referential deps would make every single block a deadlock
export const RECOVERY_ACTION_DEPENDENCIES: Record<string, string[]> = {
  EXPAND_SEARCH: ['RUN_VERIFICATION'],
  RUN_VERIFICATION: ['EXPAND_SEARCH'],
  EXECUTE_STEP: ['RUN_VERIFICATION'],
}

function detectDeadlock(blockMask: Set<string>): boolean {
  for (const start of blockMask) {
    const visited = new Set<string>()
    const hasCycle = (node: string): boolean => {
      visited.add(node)
      for (const dep of RECOVERY_ACTION_DEPENDENCIES[node] ?? []) {
        if (!blockMask.has(dep)) continue
        if (visited.has(dep)) return true
        if (hasCycle(dep)) return true
      }
      return false
    }
    if (hasCycle(start)) return true
  }
  return false
}

export function resolveControlState(
  diagnostics: Diagnostics,
  worldModel: WorldModel,
  failureDiagnostics: FailureDiagnostics,
  step?: number,
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

  // TIER 1: any SYSTEM_BREAKING contradiction → BLOCKED, return immediately; TIER 2+ not evaluated
  if (worldModel.contradictions.some(c => c.severity === 'SYSTEM_BREAKING')) {
    cs.risk_state = 'BLOCKED'
    cs.escalation_reason = 'CONTRADICTION'
    cs.generation_id = worldModel.generation_id
    cs.notes = notes
    return cs
  }

  // TIER 2: any sub-dim < CRITICAL_THRESHOLD → add action_class to block_mask; continue to lower tiers
  const blockMask = new Set<string>()
  const dimensionMinValues: Array<[string, number]> = [
    ['belief_health', Math.min(
      diagnostics.belief_health.freshness,
      diagnostics.belief_health.consistency,
      diagnostics.belief_health.support,
    )],
    ['coverage_health', Math.min(
      diagnostics.coverage_health.symptom_coverage,
      diagnostics.coverage_health.explanation_coverage,
    )],
    ['verification_health', Math.min(
      diagnostics.verification_health.strength,
      diagnostics.verification_health.feasibility,
    )],
    ['execution_health', Math.min(
      diagnostics.execution_health.progress_rate,
      diagnostics.execution_health.failure_recurrence,
      diagnostics.execution_health.oscillation_score,
    )],
  ]
  for (const [dim, minVal] of dimensionMinValues) {
    if (minVal < CRITICAL_THRESHOLD) {
      blockMask.add(HEALTH_DIMENSION_ACTION_CLASS[dim])
    }
  }
  if (blockMask.size > 0) {
    cs.block_mask = [...blockMask]
    // DEADLOCK CHECK: cycle in blocked subgraph → HUMAN_REQUIRED; no autonomous recovery attempted
    if (detectDeadlock(blockMask)) {
      cs.risk_state = 'BLOCKED'
      cs.escalation_reason = 'HUMAN_REQUIRED'
      cs.generation_id = worldModel.generation_id
      cs.notes = notes
      return cs
    }
  }

  // TIER 3: coverage low → CAUTIOUS; exploration actions not requiring blocked dimension are allowed
  if (
    diagnostics.coverage_health.symptom_coverage < HIGH_THRESHOLD ||
    diagnostics.coverage_health.explanation_coverage < DIVERSITY_FLOOR
  ) {
    cs.risk_state = 'CAUTIOUS'
  }

  // TIER 4: belief sub-scores below caution threshold OR high pattern confidence → elevation
  const beliefSubDims = [
    diagnostics.belief_health.freshness,
    diagnostics.belief_health.consistency,
    diagnostics.belief_health.support,
  ]
  const patternConfidence = failureDiagnostics.matched_pattern?.confidence ?? 0
  if (beliefSubDims.some(d => d < CAUTION_THRESHOLD) || patternConfidence > PATTERN_THRESHOLD) {
    cs.risk_state = 'CAUTIOUS'
    const elevationFactor = computeElevationFactor(beliefSubDims)
    if (elevationFactor > 0) {
      notes.push(`caution_elevation=${elevationFactor.toFixed(3)}`)
    }
  }

  // TIER 5: NORMAL — implicit; ControlState defaults to 'NORMAL', no assignment needed here

  // dep_class_gap_annotation attached to notes[] only — NOT evaluated in any tier
  if (diagnostics.dep_class_gap_annotation) {
    notes.push(`dep_class_gap: ${diagnostics.dep_class_gap_annotation}`)
  }

  cs.notes = notes
  cs.generation_id = worldModel.generation_id
  return cs
}
