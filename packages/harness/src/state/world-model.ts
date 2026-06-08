import { z } from 'zod'

export const ObservationSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.string(),
  timestamp: z.string(),
})
export type Observation = z.infer<typeof ObservationSchema>

export const BeliefSchema = z.object({
  id: z.string(),
  content: z.string(),
  reliability: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  derived_from: z.array(z.string()),
  timestamp: z.string(),
})
export type Belief = z.infer<typeof BeliefSchema>

export const ContradictionSchema = z.object({
  id: z.string(),
  type: z.enum(['pairwise', 'set-level', 'temporal', 'abstraction']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'SYSTEM_BREAKING']),
  scope: z.enum(['local', 'task', 'global']),
  description: z.string(),
  belief_ids: z.array(z.string()),
})
export type Contradiction = z.infer<typeof ContradictionSchema>

export const EnvironmentChangeSchema = z.object({
  id: z.string(),
  description: z.string(),
  affected_paths: z.array(z.string()),
  timestamp: z.string(),
})
export type EnvironmentChange = z.infer<typeof EnvironmentChangeSchema>

export const BeliefNodeSchema = z.object({
  belief_id: z.string(),
  confidence: z.number(),
})
export type BeliefNode = z.infer<typeof BeliefNodeSchema>

export const DepEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  confidence: z.number(),
  verified: z.boolean(),
})
export type DepEdge = z.infer<typeof DepEdgeSchema>

export const PropagationTaskSchema = z.object({
  source_belief_id: z.string(),
  target_belief_id: z.string(),
})
export type PropagationTask = z.infer<typeof PropagationTaskSchema>

export const BeliefDepGraphSchema = z.object({
  belief_nodes: z.array(BeliefNodeSchema),
  derived_from_edges: z.array(DepEdgeSchema),
  invalidation_frontier: z.array(z.string()),
  propagation_queue: z.array(PropagationTaskSchema),
  unverified_edge_ratio: z.number(),
  confidence_decay_rate: z.number(),
})
export type BeliefDepGraphData = z.infer<typeof BeliefDepGraphSchema>

export class BeliefDepGraph {
  belief_nodes: BeliefNode[]
  derived_from_edges: DepEdge[]
  invalidation_frontier: string[]
  propagation_queue: PropagationTask[]
  unverified_edge_ratio: number
  confidence_decay_rate: number

  constructor(data?: Partial<BeliefDepGraphData>) {
    this.belief_nodes = data?.belief_nodes ?? []
    this.derived_from_edges = data?.derived_from_edges ?? []
    this.invalidation_frontier = data?.invalidation_frontier ?? []
    this.propagation_queue = data?.propagation_queue ?? []
    this.unverified_edge_ratio = data?.unverified_edge_ratio ?? 0
    this.confidence_decay_rate = data?.confidence_decay_rate ?? 0.05
  }

  recomputeUnverifiedEdgeRatio(): void {
    const total = this.derived_from_edges.length
    if (total === 0) { this.unverified_edge_ratio = 0; return }
    const unverified = this.derived_from_edges.filter(e => !e.verified).length
    this.unverified_edge_ratio = unverified / total
  }

  toJSON(): BeliefDepGraphData {
    return {
      belief_nodes: this.belief_nodes,
      derived_from_edges: this.derived_from_edges,
      invalidation_frontier: this.invalidation_frontier,
      propagation_queue: this.propagation_queue,
      unverified_edge_ratio: this.unverified_edge_ratio,
      confidence_decay_rate: this.confidence_decay_rate,
    }
  }

  static fromJSON(json: BeliefDepGraphData): BeliefDepGraph {
    const parsed = BeliefDepGraphSchema.parse(json)
    return new BeliefDepGraph(parsed)
  }
}

export const DepGraphBudgetSchema = z.object({
  max_unverified_edge_ratio: z.number(),
  refresh_policy: z.string(),
  confidence_decay_rate: z.number(),
})
export type DepGraphBudgetData = z.infer<typeof DepGraphBudgetSchema>

export class DepGraphBudget {
  max_unverified_edge_ratio: number
  refresh_policy: string
  confidence_decay_rate: number

  constructor(data?: Partial<DepGraphBudgetData>) {
    this.max_unverified_edge_ratio = data?.max_unverified_edge_ratio ?? 0.3
    this.refresh_policy = data?.refresh_policy ?? 'per_iteration'
    this.confidence_decay_rate = data?.confidence_decay_rate ?? 0.05
  }

  applyDecay(graph: BeliefDepGraph): void {
    for (const edge of graph.derived_from_edges) {
      edge.confidence = Math.max(0, edge.confidence - this.confidence_decay_rate)
    }
    graph.recomputeUnverifiedEdgeRatio()
  }

  toJSON(): DepGraphBudgetData {
    return {
      max_unverified_edge_ratio: this.max_unverified_edge_ratio,
      refresh_policy: this.refresh_policy,
      confidence_decay_rate: this.confidence_decay_rate,
    }
  }
}

export const WorldModelSchema = z.object({
  generation_id: z.number().int().nonnegative(),
  observations: z.array(ObservationSchema),
  beliefs: z.array(BeliefSchema),
  assumptions: z.array(z.string()),
  contradictions: z.array(ContradictionSchema),
  environment_change_log: z.array(EnvironmentChangeSchema),
  completeness_flags: z.record(z.boolean()),
})
export type WorldModelData = z.infer<typeof WorldModelSchema>

export class WorldModel {
  generation_id: number
  observations: Observation[]
  beliefs: Belief[]
  assumptions: string[]
  contradictions: Contradiction[]
  environment_change_log: EnvironmentChange[]
  completeness_flags: Record<string, boolean>

  constructor(data?: Partial<WorldModelData>) {
    this.generation_id = data?.generation_id ?? 0
    this.observations = data?.observations ?? []
    this.beliefs = data?.beliefs ?? []
    this.assumptions = data?.assumptions ?? []
    this.contradictions = data?.contradictions ?? []
    this.environment_change_log = data?.environment_change_log ?? []
    this.completeness_flags = data?.completeness_flags ?? {}
  }

  addBelief(belief: Belief): void {
    if (!belief.derived_from || belief.derived_from.length === 0) {
      throw new Error(
        `WorldModel invariant: belief "${belief.id}" must have a non-empty derived_from[] chain`,
      )
    }
    this.beliefs.push(belief)
  }

  incrementGenerationId(): void {
    this.generation_id++
  }

  toJSON(): WorldModelData {
    return {
      generation_id: this.generation_id,
      observations: this.observations,
      beliefs: this.beliefs,
      assumptions: this.assumptions,
      contradictions: this.contradictions,
      environment_change_log: this.environment_change_log,
      completeness_flags: this.completeness_flags,
    }
  }

  static fromJSON(json: WorldModelData): WorldModel {
    const parsed = WorldModelSchema.parse(json)
    return new WorldModel(parsed)
  }
}
