import type { WorldModel } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { HypothesisSet, Hypothesis } from '../state/hypothesis-set.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { MemoryState, PrunedRegion } from '../state/memory-state.js'
import { normalise, DimensionType } from '../normalise.js'

const MAX_BELIEFS = 10
const KEEP_BELIEFS = 5
const DIVERSITY_THRESHOLD = 0.7
const MAX_PASSES = 10

type GenerationSource = 'symptom_inference' | 'counterfactual' | 'failure_mode_library' | 'analogy'

function makeSeed(id: string, source: GenerationSource, explanation: string, confidence = 0.5): Hypothesis {
  return {
    id,
    explanation,
    confidence,
    predicted_observations: [],
    discriminating_evidence: [],
    generation_sources: [source],
    diversity_score: 0,
  }
}

function computeDiversityScore(hypothesisSet: HypothesisSet): number {
  if (hypothesisSet.active.length === 0) return 0
  const sources = new Set<string>()
  for (const h of hypothesisSet.active) {
    for (const s of h.generation_sources) sources.add(s)
  }
  const sourceCounts: number[] = Array.from(sources).map(
    s => hypothesisSet.active.filter(h => h.generation_sources.includes(s)).length,
  )
  return normalise(sourceCounts, DimensionType.entropy)
}

function generateFromSource(
  source: GenerationSource,
  worldModel: WorldModel,
  evidenceStore: EvidenceStore,
  hypothesisSet: HypothesisSet,
  failureDiagnostics: FailureDiagnostics,
  pass: number,
): Hypothesis[] {
  const suffix = pass > 0 ? `_p${pass}` : ''

  switch (source) {
    case 'symptom_inference': {
      const obs = evidenceStore.observations
      if (obs.length > 0) {
        return obs.slice(0, 1).map((o, i) =>
          makeSeed(`symp_${o.id}${suffix}`, source, `Symptom inference from: ${o.obs}`, 0.4 + i * 0.05),
        )
      }
      return [makeSeed(`symp_default${suffix}`, source, 'No symptoms observed — hypothesis: system nominal', 0.3)]
    }

    case 'counterfactual': {
      const beliefs = worldModel.beliefs
      if (beliefs.length > 0) {
        return [makeSeed(
          `counter_${beliefs[0].id}${suffix}`,
          source,
          `Counterfactual: if "${beliefs[0].content}" were false, goal would be impacted`,
          0.35,
        )]
      }
      return [makeSeed(`counter_default${suffix}`, source, 'Counterfactual: prior state differs from expected', 0.3)]
    }

    case 'failure_mode_library': {
      const symptoms = evidenceStore.observations.map(o => o.obs)
      const match = failureDiagnostics.failure_mode_library.match(symptoms)
      if (match) {
        return [makeSeed(
          `fml_${match.matched_pattern}${suffix}`,
          source,
          `Failure mode match: ${match.failure_class} (confidence ${match.confidence.toFixed(2)})`,
          match.confidence,
        )]
      }
      return [makeSeed(`fml_unknown${suffix}`, source, 'Failure mode: unknown pattern — exploratory', 0.2)]
    }

    case 'analogy': {
      if (hypothesisSet.eliminated.length > 0) {
        const template = hypothesisSet.eliminated[0]
        return [makeSeed(
          `analogy_${template.id}${suffix}`,
          source,
          `Analogy from eliminated hypothesis: ${template.explanation}`,
          0.25,
        )]
      }
      return [makeSeed(`analogy_default${suffix}`, source, 'Analogy: no prior eliminations — structural guess', 0.2)]
    }
  }
}

function applyEliminationPolicy(
  hypothesisSet: HypothesisSet,
  worldModel: WorldModel,
): void {
  const toEliminate = hypothesisSet.active.filter(h => {
    if (h.confidence < hypothesisSet.elimination_policy.floor) return true
    // Check contradicting evidence: if a contradiction's description references this hypothesis ID
    if (worldModel.contradictions.some(c => c.description.includes(h.id))) return true
    return false
  })
  for (const h of toEliminate) {
    hypothesisSet.eliminate(h)
  }
}

export function generateUpdateHypotheses(
  worldModel: WorldModel,
  evidenceStore: EvidenceStore,
  hypothesisSet: HypothesisSet,
  failureDiagnostics: FailureDiagnostics,
  memoryState: MemoryState,
): void {
  const sources: GenerationSource[] = [
    'symptom_inference',
    'counterfactual',
    'failure_mode_library',
    'analogy',
  ]

  let pass = 0
  let diversityScore = computeDiversityScore(hypothesisSet)

  // Generate until diversity_score >= DIVERSITY_THRESHOLD or MAX_PASSES reached
  do {
    const existingIds = new Set(hypothesisSet.active.map(h => h.id))
    for (const source of sources) {
      const newHypotheses = generateFromSource(
        source, worldModel, evidenceStore, hypothesisSet, failureDiagnostics, pass,
      )
      for (const h of newHypotheses) {
        if (!existingIds.has(h.id)) {
          hypothesisSet.active.push(h)
          existingIds.add(h.id)
        }
      }
    }
    diversityScore = computeDiversityScore(hypothesisSet)
    pass++
  } while (diversityScore < DIVERSITY_THRESHOLD && pass < MAX_PASSES)

  // Update diversity_score on each active hypothesis
  for (const h of hypothesisSet.active) {
    h.diversity_score = diversityScore
  }

  // Apply elimination policy
  applyEliminationPolicy(hypothesisSet, worldModel)

  // MAX_BELIEFS/KEEP_BELIEFS pruning: prune active set when it exceeds MAX_BELIEFS
  if (hypothesisSet.active.length > MAX_BELIEFS) {
    hypothesisSet.active.sort((a, b) => b.confidence - a.confidence)
    const pruned = hypothesisSet.active.splice(KEEP_BELIEFS)
    const now = new Date().toISOString()
    for (const h of pruned) {
      const region: PrunedRegion = {
        id: `hypothesis_${h.id}`,
        description: h.explanation,
        token_count: 0,
        pruned_at: now,
      }
      memoryState.compression_risk.pruned_regions.push(region)
    }
  }
}

export function computeSourceEntropy(hypothesisSet: HypothesisSet): number {
  return computeDiversityScore(hypothesisSet)
}
