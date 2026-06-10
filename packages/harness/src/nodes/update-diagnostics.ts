import type { WorldModel, BeliefDepGraph } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { TaskGraph } from '../state/task-graph.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { Diagnostics } from '../state/diagnostics.js'
import { normalise, assertNormalised, DimensionType } from '../normalise.js'
import { computeSourceEntropy } from './generate-update-hypotheses.js'

function checkAbstractionAlignment(taskGraph: TaskGraph): number {
  if (taskGraph.tasks.length === 0) return 1.0
  const maxLevel = 2
  const mean = taskGraph.tasks.reduce((acc, t) => acc + t.abstraction_level, 0) / taskGraph.tasks.length
  // lower abstraction_level (more concrete) = better fit
  return normalise(1 - mean / (maxLevel + 1), DimensionType.ratio)
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
): void {
  // belief_health
  const flags = Object.values(worldModel.completeness_flags)
  const staleFlagRatio = flags.length > 0 ? flags.filter(f => !f).length / flags.length : 0
  const freshness = normalise(1 - staleFlagRatio, DimensionType.ratio)
  assertNormalised(freshness, 'belief_health.freshness')

  const contradictionDensity = worldModel.beliefs.length > 0
    ? Math.min(1, worldModel.contradictions.length / worldModel.beliefs.length)
    : 0
  const consistency = normalise(1 - contradictionDensity, DimensionType.ratio)
  assertNormalised(consistency, 'belief_health.consistency')

  const reliabilityWeight: Record<string, number> = { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.0 }
  const meanSupport = worldModel.beliefs.length > 0
    ? worldModel.beliefs.reduce((acc, b) => acc + (reliabilityWeight[b.reliability] ?? 0.5), 0) / worldModel.beliefs.length
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

  // feasibility: based on tool/evidence adequacy + abstraction_fit (only recomputed when taskGraph.changed)
  let abstractionFit: number
  if (taskGraph.changed) {
    abstractionFit = checkAbstractionAlignment(taskGraph)
  } else {
    // Approximate from current feasibility — avoids recomputing when unchanged
    abstractionFit = diagnostics.verification_health.feasibility
  }

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

  const progressRate = normalise(
    totalTasks > 0 ? completedTasks / totalTasks : 1.0,
    DimensionType.ratio,
  )
  assertNormalised(progressRate, 'execution_health.progress_rate')

  const failureRecurrence = normalise(
    1 - Math.min(1, failureDiagnostics.failure_history.length / 10),
    DimensionType.ratio,
  )
  assertNormalised(failureRecurrence, 'execution_health.failure_recurrence')

  const failureRatio = totalTasks > 0 ? failedTasks / totalTasks : 0
  const oscillationScore = normalise(1 - failureRatio, DimensionType.ratio)
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
