import type { WorldModel, Belief, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { TaskGraph } from '../state/task-graph.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { propagateBeliefs } from './update-world-model.js'
import { detectContradictions } from './detect-contradictions.js'
import { generateUpdateHypotheses } from './generate-update-hypotheses.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import { MemoryState } from '../state/memory-state.js'
import { normalise, DimensionType } from '../normalise.js'

const ADVERSARIAL_PROXIMITY_THRESHOLD = 0.5
const ADVERSARIAL_MAX_SEEDS = 10
const BFS_HOP_LIMIT = 3

export interface ReviewLensResult {
  findings: string[]
  reopened_task_ids: string[]
}

export interface ReviewPassResult {
  implementer_findings: string[]
  reviewer_findings: string[]
  adversarial_findings: string[]
  reopened_task_ids: string[]
}

// BFS over the belief dep graph, returning beliefs within hop_limit of the success criteria chain
function seedAdversarialPrior(
  worldModel: WorldModel,
  successCriteria: string[],
  beliefDepGraph: BeliefDepGraph,
  maxSeeds: number,
): Belief[] {
  // Find beliefs whose content references the success criteria (proximity by content)
  const criteriaSet = new Set(successCriteria.map(c => c.toLowerCase()))

  function causalProximity(belief: Belief): number {
    const text = belief.content.toLowerCase()
    // Direct match → high proximity
    for (const criterion of criteriaSet) {
      if (text.includes(criterion)) return 1.0
    }
    // Derived from observations that reference success criteria
    if (belief.derived_from.length > 0) return 0.6
    return 0.1
  }

  // BFS from beliefs linked to success criteria
  const visited = new Set<string>()
  const queue: Array<{ id: string; hop: number }> = []
  const selected: Belief[] = []

  // Start from beliefs with high direct proximity
  for (const belief of worldModel.beliefs) {
    if (causalProximity(belief) >= ADVERSARIAL_PROXIMITY_THRESHOLD) {
      queue.push({ id: belief.id, hop: 0 })
      visited.add(belief.id)
    }
  }

  while (queue.length > 0 && selected.length < maxSeeds) {
    const { id, hop } = queue.shift()!
    const belief = worldModel.beliefs.find(b => b.id === id)
    if (!belief) continue

    selected.push(belief)

    if (hop >= BFS_HOP_LIMIT) continue

    // Follow dep graph edges (forward and backward)
    for (const edge of beliefDepGraph.derived_from_edges) {
      const nextId = edge.from === id ? edge.to : edge.to === id ? edge.from : null
      if (nextId && !visited.has(nextId)) {
        visited.add(nextId)
        queue.push({ id: nextId, hop: hop + 1 })
      }
    }
  }

  return selected
}

function implementerLens(worldModel: WorldModel, successCriteria: string[]): ReviewLensResult {
  const findings: string[] = []
  const reopened: string[] = []

  // "Did I do what I intended?" — check beliefs cover success criteria
  for (const criterion of successCriteria) {
    const covered = worldModel.beliefs.some(b =>
      b.content.toLowerCase().includes(criterion.toLowerCase()),
    )
    if (!covered) {
      findings.push(`Success criterion not covered by any belief: "${criterion}"`)
    }
  }

  return { findings, reopened_task_ids: reopened }
}

function reviewerLens(worldModel: WorldModel, successCriteria: string[]): ReviewLensResult {
  const findings: string[] = []
  const reopened: string[] = []

  // "What would a PR reviewer criticise?" — check for contradictions and weak evidence
  for (const contradiction of worldModel.contradictions) {
    if (contradiction.severity === 'HIGH' || contradiction.severity === 'SYSTEM_BREAKING') {
      findings.push(`Unresolved ${contradiction.severity} contradiction: ${contradiction.description}`)
    }
  }

  const weakBeliefs = worldModel.beliefs.filter(b => b.reliability === 'LOW')
  if (weakBeliefs.length > worldModel.beliefs.length / 2) {
    findings.push(`More than half of beliefs have LOW reliability (${weakBeliefs.length}/${worldModel.beliefs.length})`)
  }

  void successCriteria
  return { findings, reopened_task_ids: reopened }
}

function adversarialLens(
  worldModel: WorldModel,
  successCriteria: string[],
  failureDiagnostics: FailureDiagnostics,
  beliefDepGraph: BeliefDepGraph,
): ReviewLensResult {
  const findings: string[] = []
  const reopened: string[] = []

  // Seed adversarial prior — discarded after this lens, never stored in worldModel
  const adversarialPrior = seedAdversarialPrior(
    worldModel,
    successCriteria,
    beliefDepGraph,
    ADVERSARIAL_MAX_SEEDS,
  )

  // Challenge each seeded belief adversarially
  for (const belief of adversarialPrior) {
    if (belief.reliability === 'HIGH') {
      // Check if contradicted
      const contradicted = worldModel.contradictions.some(c =>
        c.belief_ids.includes(belief.id),
      )
      if (contradicted) {
        findings.push(`Adversarial challenge: HIGH-reliability belief "${belief.id}" is contradicted`)
      }
    }
  }

  // Seed from failure class priors
  const classPriors = failureDiagnostics.failure_mode_library.class_priors
  for (const [cls, prior] of Object.entries(classPriors)) {
    if (prior > 0.5) {
      findings.push(`High prior probability (${prior.toFixed(2)}) for failure class "${cls}"`)
    }
  }

  // adversarial_prior discarded here — never stored in worldModel (INV-adversarial)
  void adversarialPrior

  return { findings, reopened_task_ids: reopened }
}

function recomputeAbstractionFit(
  taskGraph: TaskGraph,
  diagnostics: Diagnostics,
): void {
  // Unconditionally recompute — reviewer pass has full execution history
  if (taskGraph.tasks.length === 0) {
    diagnostics.verification_health.feasibility = 1.0
    return
  }
  const maxLevel = 2
  const mean = taskGraph.tasks.reduce((acc, t) => acc + t.abstraction_level, 0) / taskGraph.tasks.length
  diagnostics.verification_health.feasibility = normalise(
    1 - mean / (maxLevel + 1),
    DimensionType.ratio,
  )
}

export interface PropagationQueue {
  reopenedTaskIds: string[]
}

// drain_propagation_queue: empties the queue atomically and returns reopened task IDs
export function drainPropagationQueue(queue: PropagationQueue): string[] {
  const ids = [...queue.reopenedTaskIds]
  queue.reopenedTaskIds = []
  return ids
}

export function reviewerPass(
  worldModel: WorldModel,
  successCriteria: string[],
  failureDiagnostics: FailureDiagnostics,
  beliefDepGraph: BeliefDepGraph,
  depGraphBudget: DepGraphBudget,
  hypothesisSet: HypothesisSet,
  taskGraph: TaskGraph,
  diagnostics: Diagnostics,
  evidenceStore: EvidenceStore,
  propagationQueue: PropagationQueue,
): ReviewPassResult {
  // 3 lenses in fixed sequence
  const implResult = implementerLens(worldModel, successCriteria)
  const reviewResult = reviewerLens(worldModel, successCriteria)
  const adversarialResult = adversarialLens(
    worldModel,
    successCriteria,
    failureDiagnostics,
    beliefDepGraph,
  )

  // abstraction_fit recomputed unconditionally (not guarded by taskGraph.changed)
  recomputeAbstractionFit(taskGraph, diagnostics)

  // After pass: propagate_beliefs, update hypothesis set, detect_contradictions
  propagateBeliefs(beliefDepGraph, depGraphBudget, worldModel)
  generateUpdateHypotheses(worldModel, evidenceStore, hypothesisSet, failureDiagnostics, new MemoryState())
  detectContradictions(worldModel, evidenceStore, hypothesisSet)

  // Collect all reopened task IDs from all lenses
  const allReopened = [
    ...implResult.reopened_task_ids,
    ...reviewResult.reopened_task_ids,
    ...adversarialResult.reopened_task_ids,
  ]

  // Mark findings as tasks to reopen if tasks are referenced
  for (const finding of [...implResult.findings, ...reviewResult.findings]) {
    // Look for task IDs in findings referencing specific tasks
    for (const task of taskGraph.tasks) {
      if (finding.includes(task.id) && task.status === 'COMPLETE') {
        if (!allReopened.includes(task.id)) {
          allReopened.push(task.id)
          propagationQueue.reopenedTaskIds.push(task.id)
        }
      }
    }
  }

  // drain_propagation_queue atomically
  const reopenedTaskIds = drainPropagationQueue(propagationQueue)

  return {
    implementer_findings: implResult.findings,
    reviewer_findings: reviewResult.findings,
    adversarial_findings: adversarialResult.findings,
    reopened_task_ids: reopenedTaskIds,
  }
}
