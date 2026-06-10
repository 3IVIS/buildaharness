import type { ControlState } from '../state/control-state.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { ControlStateResolverFn } from '../generation-id.js'
import { WorldModel, type Belief, type Observation, type Contradiction } from '../state/world-model.js'
import { TaskGraph, type Task } from '../state/task-graph.js'
import { detectContradictions } from './detect-contradictions.js'

export const PESSIMISTIC_THRESHOLD = 0.5

export interface SelectTaskResult {
  task: Task | null
  concurrentTask: Task | null
  escalate: boolean
}

export function selectTask(taskGraph: TaskGraph, controlState: ControlState): SelectTaskResult {
  if (controlState.escalation_reason === 'HUMAN_REQUIRED') {
    return { task: null, concurrentTask: null, escalate: true }
  }

  const taskMap = new Map(taskGraph.tasks.map(t => [t.id, t]))
  const eligible = taskGraph.tasks.filter(t => {
    if (t.status !== 'PENDING') return false
    return t.depends_on.every(depId => taskMap.get(depId)?.status === 'COMPLETE')
  })

  if (eligible.length === 0) return { task: null, concurrentTask: null, escalate: false }

  const riskOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
  const sorted = [...eligible].sort((a, b) => (riskOrder[a.risk_level] ?? 1) - (riskOrder[b.risk_level] ?? 1))

  const primary = sorted[0]
  if (sorted.length < 2) return { task: primary, concurrentTask: null, escalate: false }

  const secondary = sorted[1]
  const primaryDomains = new Set(primary.parallel_write_domains)
  const hasOverlap = secondary.parallel_write_domains.some(d => primaryDomains.has(d))

  if (!hasOverlap) return { task: primary, concurrentTask: secondary, escalate: false }

  // Overlapping write domains: consult conflict_probability_cache
  const conflictProb = Math.max(
    0,
    ...primary.parallel_write_domains.flatMap(da =>
      secondary.parallel_write_domains.map(db => taskGraph.getConflictProbability(da, db)),
    ),
  )

  if (conflictProb > PESSIMISTIC_THRESHOLD) {
    return { task: primary, concurrentTask: null, escalate: false }
  }
  return { task: primary, concurrentTask: secondary, escalate: false }
}

export interface ParallelBranch {
  worldModel: WorldModel
  controlState: ControlState
}

export function mergeWorldModels(wm1: WorldModel, wm2: WorldModel): WorldModel {
  const merged = new WorldModel()
  merged.generation_id = Math.max(wm1.generation_id, wm2.generation_id)

  const beliefMap = new Map<string, Belief>()
  for (const b of [...wm1.beliefs, ...wm2.beliefs]) beliefMap.set(b.id, b)
  merged.beliefs = [...beliefMap.values()]

  const obsMap = new Map<string, Observation>()
  for (const o of [...wm1.observations, ...wm2.observations]) obsMap.set(o.id, o)
  merged.observations = [...obsMap.values()]

  const contMap = new Map<string, Contradiction>()
  for (const c of [...wm1.contradictions, ...wm2.contradictions]) contMap.set(c.id, c)
  merged.contradictions = [...contMap.values()]

  // Deduplicate assumptions to prevent duplicate string entries
  merged.assumptions = [...new Set([...wm1.assumptions, ...wm2.assumptions])]
  merged.completeness_flags = { ...wm1.completeness_flags, ...wm2.completeness_flags }

  return merged
}

export interface ReconcileResult {
  worldModel: WorldModel
  controlState: ControlState
}

export function reconcileParallelBranches(
  branches: ParallelBranch[],
  taskGraph: TaskGraph,
  diagnostics: Diagnostics,
  failureDiagnostics: FailureDiagnostics,
  evidenceStore: EvidenceStore,
  hypothesisSet: HypothesisSet,
  resolver: ControlStateResolverFn,
  parallelDomainPairs?: Array<[string, string]>,
): ReconcileResult {
  if (branches.length === 0) throw new Error('reconcileParallelBranches: no branches provided')

  // Take max generation_id across joining branches
  const maxGenId = Math.max(...branches.map(b => b.worldModel.generation_id))

  let merged = branches[0].worldModel
  for (let i = 1; i < branches.length; i++) {
    merged = mergeWorldModels(merged, branches[i].worldModel)
  }
  merged.generation_id = maxGenId

  detectContradictions(merged, evidenceStore, hypothesisSet)

  const mergedCS = resolver(diagnostics, merged, failureDiagnostics)
  mergedCS.generation_id = merged.generation_id

  // Record no-conflict observations for provided domain pairs — refines cache estimates
  if (parallelDomainPairs) {
    for (const [da, db] of parallelDomainPairs) {
      const existing = taskGraph.getConflictProbability(da, db)
      taskGraph.setConflictProbability(da, db, existing > 0 ? existing * 0.9 : 0)
    }
  }

  return { worldModel: merged, controlState: mergedCS }
}
