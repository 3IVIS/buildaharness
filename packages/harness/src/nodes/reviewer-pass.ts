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
import { checkAbstractionAlignment } from './update-diagnostics.js'

const ADVERSARIAL_PROXIMITY_THRESHOLD = 0.5
const ADVERSARIAL_MAX_SEEDS = 10
const BFS_HOP_LIMIT = 3

export interface ReviewLensResult {
  findings: string[]
  reopened_task_ids: string[]
}

export type ReviewerVerdictSeverity = 'LOW' | 'MEDIUM' | 'HIGH'
export type ReviewerVerdictLens = 'implementer' | 'reviewer' | 'adversarial'

/**
 * Bounded, single-slot verdict that survives into the next iteration's ControlState
 * resolve (Phase I / ADR-003 finding F-3, authority-map ruling A-4). Mirrors
 * reviewer.py's ReviewerVerdict exactly — see resolve-control-state.ts's
 * applyPendingReviewerVerdict() for the consuming side (INV-18).
 */
export interface ReviewerVerdict {
  severity: ReviewerVerdictSeverity
  lens: ReviewerVerdictLens
  summary: string
}

const REVIEWER_VERDICT_SEVERITY_RANK: Record<ReviewerVerdictSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

/**
 * TS findings are plain strings (no structured finding_type/severity like reviewer.py's
 * ReviewFinding dataclass), so severity is inferred from each lens's fixed finding-text
 * patterns instead — chosen to mirror reviewer.py's own severity assignment: implementer's
 * "no supporting observation" / open-HIGH-contradiction checks and reviewer's
 * required-interface-field miss are HIGH there, but TS's implementerLens/reviewerLens don't
 * implement those specific checks (only success-criterion coverage and confidence/
 * contradiction summaries) — so this maps what TS *does* find: an unresolved HIGH/
 * SYSTEM_BREAKING contradiction (reviewer) and a contradicted high-reliability adversarial
 * challenge (adversarial) as HIGH, mirroring the severity those same underlying conditions
 * get on the Python side; everything else defaults to MEDIUM (never LOW — an empty finding
 * list already short-circuits below, and TS has no lens that only ever produces
 * informational, non-actionable findings).
 */
function classifyFindingSeverity(lens: ReviewerVerdictLens, finding: string): ReviewerVerdictSeverity {
  if (lens === 'reviewer' && (finding.startsWith('Unresolved HIGH') || finding.startsWith('Unresolved SYSTEM_BREAKING'))) {
    return 'HIGH'
  }
  if (lens === 'adversarial' && finding.startsWith('Adversarial challenge:')) {
    return 'HIGH'
  }
  return 'MEDIUM'
}

/** The highest-severity finding across all three lenses becomes the pending verdict — a
 * resolver input, not a log of every finding. None when nothing reaches MEDIUM — mirrors
 * the Python twin's `_derive_pending_verdict()` (adapter/harness/reviewer.py), which filters
 * candidates to `severity >= MEDIUM` before picking the max; classifyFindingSeverity() never
 * actually produces 'LOW' today (same as Python: no *_lens() finding is ever constructed
 * with severity="LOW" there either — MEDIUM is the floor in both engines currently), but the
 * filter itself is real, load-bearing parity — without it, a LOW finding either engine adds
 * in the future would silently start forcing pending_verdict/CAUTIOUS in TS while Python
 * continues to correctly ignore it. Ties keep the first-encountered finding (lens order:
 * implementer, reviewer, adversarial — the pass's own fixed sequence). */
function derivePendingVerdict(
  implementerFindings: string[],
  reviewerFindings: string[],
  adversarialFindings: string[],
): ReviewerVerdict | null {
  const candidates: ReviewerVerdict[] = [
    ...implementerFindings.map(f => ({ severity: classifyFindingSeverity('implementer', f), lens: 'implementer' as const, summary: f })),
    ...reviewerFindings.map(f => ({ severity: classifyFindingSeverity('reviewer', f), lens: 'reviewer' as const, summary: f })),
    ...adversarialFindings.map(f => ({ severity: classifyFindingSeverity('adversarial', f), lens: 'adversarial' as const, summary: f })),
  ].filter(c => REVIEWER_VERDICT_SEVERITY_RANK[c.severity] >= REVIEWER_VERDICT_SEVERITY_RANK.MEDIUM)
  if (candidates.length === 0) return null
  return candidates.reduce((top, c) =>
    REVIEWER_VERDICT_SEVERITY_RANK[c.severity] > REVIEWER_VERDICT_SEVERITY_RANK[top.severity] ? c : top,
  )
}

export interface ReviewPassResult {
  implementer_findings: string[]
  reviewer_findings: string[]
  adversarial_findings: string[]
  reopened_task_ids: string[]
  pending_verdict: ReviewerVerdict | null
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
    const text = belief.statement.toLowerCase()
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

/**
 * Optional semantic escalation layered on top of the plain `.includes()` substring check below —
 * called only for a criterion the substring check found no coverage for, so a belief that covers
 * a success criterion in different words (a paraphrase, or any non-English phrasing) isn't
 * wrongly reported as an uncovered gap. See Phase 2/Decision 3b of
 * plans/lexical_functions_hardening_plan.html — mirrors the existing
 * contradictionChecker/semanticChangeReviewer/semanticFailureMatcher hooks on HarnessRuntime
 * (packages/harness/src/harness-runtime.ts). A caller can cheaply return `false` without an LLM
 * call for a criterion it judges the substring check already covers.
 */
export type SemanticCriterionCoverage = (criterion: string, beliefs: Belief[]) => Promise<boolean>

async function implementerLens(
  worldModel: WorldModel,
  successCriteria: string[],
  semanticCriterionCoverage?: SemanticCriterionCoverage,
): Promise<ReviewLensResult> {
  const findings: string[] = []
  const reopened: string[] = []

  // "Did I do what I intended?" — check beliefs cover success criteria
  for (const criterion of successCriteria) {
    const covered = worldModel.beliefs.some(b =>
      b.statement.toLowerCase().includes(criterion.toLowerCase()),
    )
    if (!covered) {
      const semanticallyCovered = semanticCriterionCoverage ? await semanticCriterionCoverage(criterion, worldModel.beliefs) : false
      if (!semanticallyCovered) {
        findings.push(`Success criterion not covered by any belief: "${criterion}"`)
      }
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

  const weakBeliefs = worldModel.beliefs.filter(b => b.confidence < 0.25)
  if (weakBeliefs.length > worldModel.beliefs.length / 2) {
    findings.push(`More than half of beliefs have LOW confidence (${weakBeliefs.length}/${worldModel.beliefs.length})`)
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
    if (belief.confidence >= 0.8) {
      // Check if contradicted
      const contradicted = worldModel.contradictions.some(c =>
        c.involved_belief_ids.includes(belief.id),
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
  worldModel: WorldModel,
  diagnostics: Diagnostics,
): void {
  // force=true — the reviewer pass has full execution history, so it always
  // recomputes regardless of taskGraph.changed (matches check_abstraction_alignment's
  // force parameter, used only by the P9 reviewer pass in the Python ground truth).
  diagnostics.verification_health.feasibility = checkAbstractionAlignment(taskGraph, worldModel, true)
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

export async function reviewerPass(
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
  // Adversarial lens is the expensive BFS-over-beliefs one (seedAdversarialPrior below) —
  // a caller can skip it on a low-stakes, single-task turn that has nothing worth an
  // adversarial challenge (see Phase 2, layer 11 of the harness layer activation plan).
  // Defaults true so every existing call site keeps running all 3 lenses unchanged.
  runAdversarialLens = true,
  semanticCriterionCoverage?: SemanticCriterionCoverage,
): Promise<ReviewPassResult> {
  // 3 lenses in fixed sequence (adversarial conditionally)
  const implResult = await implementerLens(worldModel, successCriteria, semanticCriterionCoverage)
  const reviewResult = reviewerLens(worldModel, successCriteria)
  const adversarialResult = runAdversarialLens
    ? adversarialLens(worldModel, successCriteria, failureDiagnostics, beliefDepGraph)
    : { findings: [], reopened_task_ids: [] }

  // abstraction_fit recomputed unconditionally (not guarded by taskGraph.changed)
  recomputeAbstractionFit(taskGraph, worldModel, diagnostics)

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
    pending_verdict: derivePendingVerdict(implResult.findings, reviewResult.findings, adversarialResult.findings),
  }
}
