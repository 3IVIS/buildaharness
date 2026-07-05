import type { WorldModel, BeliefDepGraph } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { TaskGraph } from '../state/task-graph.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { Diagnostics } from '../state/diagnostics.js'
import { normalise, assertNormalised, DimensionType } from '../normalise.js'
import { computeSourceEntropy } from './generate-update-hypotheses.js'

/**
 * Matches adapter/harness/task_graph.py's estimate_world_model_granularity():
 * 0 = module level (default), 1 = function level, 2 = statement level, inferred
 * from marker keywords in the world model's belief statements.
 */
function estimateWorldModelGranularity(worldModel: WorldModel): number {
  const beliefs = worldModel.beliefs
  if (beliefs.length === 0) return 0

  const statementMarkers = ['line ', 'line:', 'statement', 'expression', 'lineno']
  const functionMarkers = ['function', 'method', 'def ', 'procedure', '()']

  let statementCount = 0
  let functionCount = 0
  for (const b of beliefs) {
    const stmt = b.statement.toLowerCase()
    if (statementMarkers.some(m => stmt.includes(m))) statementCount++
    else if (functionMarkers.some(m => stmt.includes(m))) functionCount++
  }

  if (statementCount / beliefs.length > 0.5) return 2
  if (functionCount / beliefs.length > 0.5) return 1
  return 0
}

/**
 * Matches adapter/harness/task_graph.py's check_abstraction_alignment(): compares each
 * task's abstraction_level against the world model's actual granularity, not a fixed
 * ceiling. force=true (used by the reviewer pass) bypasses the taskGraph.changed
 * short-circuit that otherwise skips recomputation.
 */
export function checkAbstractionAlignment(taskGraph: TaskGraph, worldModel: WorldModel, force = false): number {
  if (!force && !taskGraph.changed) return 1.0

  const wmGranularity = estimateWorldModelGranularity(worldModel)
  const total = taskGraph.tasks.length
  if (total === 0) return 1.0

  const mismatched = taskGraph.tasks.filter(t => t.abstraction_level > wmGranularity + 1).length
  const score = 1.0 - mismatched / total
  return Math.max(0.0, Math.min(1.0, score))
}

function computeDepClassGapAnnotation(taskGraph: TaskGraph): string {
  const abstractLevels = new Set(taskGraph.tasks.map(t => t.abstraction_level))
  if (abstractLevels.size <= 1) return ''
  const levels = [...abstractLevels].sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) gaps.push(`gap between level ${levels[i - 1]} and ${levels[i]}`)
  }
  return gaps.length > 0 ? `Abstraction class gaps detected: ${gaps.join(', ')}` : ''
}

export function updateDiagnostics(
  worldModel: WorldModel,
  hypothesisSet: HypothesisSet,
  taskGraph: TaskGraph,
  failureDiagnostics: FailureDiagnostics,
  depGraph: BeliefDepGraph,
  diagnostics: Diagnostics,
  force = false,
): void {
  // belief_health
  const staleValues = Object.values(worldModel.stale_flags)
  const beliefCountForStaleness = Math.max(1, worldModel.beliefs.length)
  const staleFlagRatio = staleValues.filter(Boolean).length / beliefCountForStaleness
  const freshness = normalise(1 - staleFlagRatio, DimensionType.ratio)
  assertNormalised(freshness, 'belief_health.freshness')

  const contradictionDensity = worldModel.beliefs.length > 0
    ? Math.min(1, worldModel.contradictions.length / worldModel.beliefs.length)
    : 0
  const consistency = normalise(1 - contradictionDensity, DimensionType.ratio)
  assertNormalised(consistency, 'belief_health.consistency')

  const reliabilityWeight: Record<string, number> = { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.0 }
  const meanSupport = worldModel.beliefs.length > 0
    ? worldModel.beliefs.reduce((acc, b) => acc + (reliabilityWeight[b.reliability ?? 'MEDIUM'] ?? 0.5), 0) / worldModel.beliefs.length
    : 1.0
  const support = normalise(meanSupport, DimensionType.ratio)
  assertNormalised(support, 'belief_health.support')

  diagnostics.belief_health = { freshness, consistency, support }

  // coverage_health
  const symptomCoverage = normalise(
    hypothesisSet.active.length > 0
      ? Math.min(1, hypothesisSet.active.length / Math.max(worldModel.observations.length, 1))
      : 0,
    DimensionType.ratio,
  )
  assertNormalised(symptomCoverage, 'coverage_health.symptom_coverage')

  const explanationCoverage = normalise(computeSourceEntropy(hypothesisSet), DimensionType.ratio)
  assertNormalised(explanationCoverage, 'coverage_health.explanation_coverage')

  diagnostics.coverage_health = { symptom_coverage: symptomCoverage, explanation_coverage: explanationCoverage }

  // verification_health
  // strength: from dep graph (inverted unverified edge ratio)
  const strength = normalise(1 - depGraph.unverified_edge_ratio, DimensionType.ratio)
  assertNormalised(strength, 'verification_health.strength')

  // feasibility: based on tool/evidence adequacy + abstraction_fit
  // (checkAbstractionAlignment itself short-circuits to 1.0 unless taskGraph.changed or force)
  const abstractionFit = checkAbstractionAlignment(taskGraph, worldModel, force)

  const toolAdequacy = normalise(
    Object.keys(worldModel.completeness_flags).length > 0 ? 0.8 : 0.6,
    DimensionType.ratio,
  )
  const evidenceAdequacy = normalise(
    worldModel.observations.length > 0 ? 0.8 : 0.4,
    DimensionType.ratio,
  )
  const feasibility = normalise(
    { components: [toolAdequacy, evidenceAdequacy, abstractionFit], weights: [1, 1, 0.3] },
    DimensionType.composite,
  )
  assertNormalised(feasibility, 'verification_health.feasibility')

  diagnostics.verification_health = { strength, feasibility }

  // execution_health
  const totalTasks = taskGraph.tasks.length
  const completedTasks = taskGraph.tasks.filter(t => t.status === 'COMPLETE').length
  const failedTasks = taskGraph.tasks.filter(t => t.status === 'FAILED').length
  const attemptedTasks = completedTasks + failedTasks

  // progress_rate: higher=better; return 1.0 until tasks have been attempted
  // (matches Python: only update from journal when journal is non-empty)
  const progressRate = normalise(
    attemptedTasks > 0 ? completedTasks / totalTasks : 1.0,
    DimensionType.ratio,
  )
  assertNormalised(progressRate, 'execution_health.progress_rate')

  // failure_recurrence: 0=healthy (no failures), 1=max failures — inverted in resolveControlState
  const failureRecurrence = normalise(
    Math.min(1, failureDiagnostics.failure_history.length / 10),
    DimensionType.ratio,
  )
  assertNormalised(failureRecurrence, 'execution_health.failure_recurrence')

  // oscillation_score: 0=healthy (no failed tasks), 1=max — inverted in resolveControlState
  const oscillationScore = normalise(totalTasks > 0 ? failedTasks / totalTasks : 0, DimensionType.ratio)
  assertNormalised(oscillationScore, 'execution_health.oscillation_score')

  diagnostics.execution_health = { progress_rate: progressRate, failure_recurrence: failureRecurrence, oscillation_score: oscillationScore }

  // failure_mode_library match
  const symptoms = worldModel.observations.map(o => o.content)
  const match = failureDiagnostics.failure_mode_library.match(symptoms)
  if (match) {
    const normalisedConfidence = normalise(match.confidence, DimensionType.match_confidence)
    failureDiagnostics.matched_pattern = { ...match, confidence: normalisedConfidence }
  } else {
    failureDiagnostics.matched_pattern = null
  }

  // dep_class_gap_annotation: advisory string only — never a numeric input to any tier
  diagnostics.dep_class_gap_annotation = computeDepClassGapAnnotation(taskGraph)
}
