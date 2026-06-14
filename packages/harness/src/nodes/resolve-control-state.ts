import type { WorldModel } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { ControlState, type BlockEntry } from '../state/control-state.js'
import { assertNormalised, normalise, DimensionType } from '../normalise.js'
import { computeElevationFactor } from '../generation-id.js'

export const CRITICAL_THRESHOLD = 0.2
export const CAUTION_THRESHOLD = 0.4

// Maps recovery_action_class → dimension names it requires to be unblocked.
// Cross-dimension only — self-referential deps would make every single block a deadlock.
export const RECOVERY_ACTION_DEPENDENCIES: Record<string, string[]> = {
  dep_graph_refresh: ['verification_strength'],
  verification_pass: ['dep_graph_quality'],
  belief_refresh: ['verification_feasibility'],
  coverage_expand: ['verification_strength'],
  execution_retry: ['dep_graph_quality'],
  oscillation_stabilise: ['belief_freshness'],
  failure_recovery: ['dep_graph_quality'],
  consistency_repair: ['verification_strength'],
  support_augment: ['belief_freshness'],
  feasibility_check: ['dep_graph_quality'],
  explanation_expand: ['belief_freshness'],
}

// Maps sub-dimension name → recovery action class for that dimension.
const DIMENSION_RECOVERY: Record<string, string> = {
  belief_freshness: 'belief_refresh',
  belief_consistency: 'consistency_repair',
  belief_support: 'support_augment',
  symptom_coverage: 'coverage_expand',
  explanation_coverage: 'explanation_expand',
  verification_strength: 'verification_pass',
  verification_feasibility: 'feasibility_check',
  progress_rate: 'execution_retry',
  failure_recurrence: 'failure_recovery',
  oscillation_score: 'oscillation_stabilise',
  dep_graph_quality: 'dep_graph_refresh',
  world_model_integrity: 'consistency_repair',
}

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

export function resolveControlState(
  diagnostics: Diagnostics,
  worldModel: WorldModel,
  failureDiagnostics: FailureDiagnostics,
  _step?: number,
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
    cs.escalation_reason = 'SYSTEM_BREAKING_CONTRADICTION'
    cs.block_mask = [{
      dimension: 'world_model_integrity',
      value: 0.0,
      recovery_action_class: 'consistency_repair',
    }]
    cs.generation_id = worldModel.generation_id
    if (diagnostics.dep_class_gap_annotation) {
      notes.push(`dep_class_gap: ${diagnostics.dep_class_gap_annotation}`)
    }
    cs.notes = notes
    return cs
  }

  // TIER 2: each sub-dim < CRITICAL_THRESHOLD gets its own BlockEntry (individual dimension granularity)
  const subDims = extractSubDimensions(diagnostics)
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
    cs.risk_state = 'BLOCKED'
    if (detectDeadlock(blockMask)) {
      cs.escalation_reason = 'HUMAN_REQUIRED'
    }
    cs.generation_id = worldModel.generation_id
    if (diagnostics.dep_class_gap_annotation) {
      notes.push(`dep_class_gap: ${diagnostics.dep_class_gap_annotation}`)
    }
    cs.notes = notes
    return cs
  }

  // TIER 3: coverage gaps in [CRITICAL_THRESHOLD, CAUTION_THRESHOLD) → CAUTIOUS
  const { symptom_coverage, explanation_coverage } = diagnostics.coverage_health
  if (
    (symptom_coverage >= CRITICAL_THRESHOLD && symptom_coverage < CAUTION_THRESHOLD) ||
    (explanation_coverage >= CRITICAL_THRESHOLD && explanation_coverage < CAUTION_THRESHOLD)
  ) {
    cs.risk_state = 'CAUTIOUS'
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

  if (elevationFactor > 0.05 && cs.risk_state === 'NORMAL') {
    cs.risk_state = 'CAUTIOUS'
  }

  // TIER 5: NORMAL — implicit; ControlState defaults to 'NORMAL'

  // dep_class_gap_annotation attached to notes[] only — NOT evaluated in any tier (INV-07)
  if (diagnostics.dep_class_gap_annotation) {
    notes.push(`dep_class_gap: ${diagnostics.dep_class_gap_annotation}`)
  }

  cs.notes = notes
  cs.generation_id = worldModel.generation_id
  return cs
}
