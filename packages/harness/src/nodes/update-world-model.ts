import type { WorldModel, Belief, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js'
import type { Evidence } from '../state/evidence-store.js'
import type { Diagnostics } from '../state/diagnostics.js'
import { normalise, DimensionType } from '../normalise.js'

function reliabilityToFloat(r: string): number {
  if (r === 'HIGH') return 1.0
  if (r === 'MEDIUM') return 0.5
  return 0.0
}

export interface BeliefInput {
  id?: string
  statement?: string
  derived_from: string[]
}

export function updateWorldModel(
  evidence: Evidence,
  worldModel: WorldModel,
  diagnostics: Diagnostics,
  beliefInput?: BeliefInput,
  regionKey?: string,
  prune?: boolean,
): void {
  const type = evidence.evidence_type

  if (type === 'OBSERVATION' || type === 'SYSTEM_ERROR') {
    // Stored in observations[] only — never auto-promoted to beliefs[]
    worldModel.observations.push({
      id: evidence.id,
      content: evidence.obs,
      source: evidence.source,
      recorded_at: evidence.freshness,
    })
    const key = regionKey ?? evidence.source
    worldModel.completeness_flags[key] = prune !== true
  } else if (type === 'INFERENCE') {
    const belief: Belief = {
      id: beliefInput?.id ?? evidence.id,
      statement: beliefInput?.statement ?? evidence.obs,
      confidence: reliabilityToFloat(evidence.reliability),
      supporting_evidence: [],
      reliability: '',
      derived_from: beliefInput?.derived_from ?? [],
      recorded_at: evidence.freshness,
    }
    // addBelief() enforces derived_from[] non-empty — throws if empty
    worldModel.addBelief(belief)
    if (regionKey) {
      worldModel.completeness_flags[regionKey] = prune !== true
    }
  }

  recomputeBeliefHealth(worldModel, diagnostics)
  worldModel.incrementGenerationId()
}

export function recomputeBeliefHealth(worldModel: WorldModel, diagnostics: Diagnostics): void {
  const staleValues = Object.values(worldModel.stale_flags)
  const beliefCountForStaleness = Math.max(1, worldModel.beliefs.length)
  const staleFlagRatio = staleValues.filter(Boolean).length / beliefCountForStaleness
  diagnostics.belief_health.freshness = normalise(1 - staleFlagRatio, DimensionType.ratio)

  const contradictionDensity = worldModel.beliefs.length > 0
    ? Math.min(1, worldModel.contradictions.length / worldModel.beliefs.length)
    : 0
  diagnostics.belief_health.consistency = normalise(1 - contradictionDensity, DimensionType.ratio)

  const meanSupport = worldModel.beliefs.length > 0
    ? worldModel.beliefs.reduce((acc, b) => acc + b.confidence, 0) / worldModel.beliefs.length
    : 1.0
  diagnostics.belief_health.support = normalise(meanSupport, DimensionType.ratio)
}

export function propagateBeliefs(
  beliefDepGraph: BeliefDepGraph,
  depGraphBudget: DepGraphBudget,
  _worldModel: WorldModel,
): void {
  for (const edge of beliefDepGraph.derived_from_edges) {
    if (edge.confidence < 1.0) {
      const sourceNode = beliefDepGraph.belief_nodes.find(n => n.belief_id === edge.from)
      const targetNode = beliefDepGraph.belief_nodes.find(n => n.belief_id === edge.to)
      if (sourceNode && targetNode) {
        // Low-confidence edge reduces propagated weight proportionally to edge confidence
        targetNode.confidence = Math.max(0, Math.min(
          targetNode.confidence,
          sourceNode.confidence * edge.confidence,
        ))
      }
    }
  }

  beliefDepGraph.recomputeUnverifiedEdgeRatio()

  // Budget breach: widen invalidation frontier to downstream nodes
  if (beliefDepGraph.unverified_edge_ratio > depGraphBudget.max_unverified_edge_ratio) {
    const frontier = new Set(beliefDepGraph.invalidation_frontier)
    const toAdd: string[] = []
    for (const edge of beliefDepGraph.derived_from_edges) {
      if (frontier.has(edge.from) && !frontier.has(edge.to)) {
        toAdd.push(edge.to)
      }
    }
    for (const nodeId of toAdd) {
      beliefDepGraph.invalidation_frontier.push(nodeId)
      frontier.add(nodeId)
    }
  }
}
