import type { WorldModel } from '../state/world-model.js'
import type { OutputContract } from '../state/output-contract.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { Task } from '../state/task-graph.js'

export type ReviewDimension =
  | 'task_alignment'
  | 'world_model_consistency'
  | 'output_contract_precheck'
  | 'code_quality'
  | 'hypothesis_compatibility'

export interface DimensionResult {
  dimension: ReviewDimension
  passed: boolean
  reason: string
}

export interface ReviewResult {
  passed: boolean
  failed_dimensions: DimensionResult[]
  consecutive_failures: number
  escalation_triggered: boolean
}

export interface ProposedChange {
  description?: string
  change_type?: string
  required_resources?: string[]
  required_state_structures?: string[]
}

const ESCALATION_THRESHOLD = 2

function getChangeDescription(proposedChange: ProposedChange): string {
  return (proposedChange.description ?? '').toLowerCase()
}

function isNegation(changeDesc: string, stmt: string): boolean {
  if (!changeDesc || !stmt) return false
  const patterns = [
    `not ${stmt}`,
    `removes ${stmt}`,
    `remove ${stmt}`,
    `delete ${stmt}`,
    `revert ${stmt}`,
    `contradicts ${stmt}`,
    `negate ${stmt}`,
    `negates ${stmt}`,
    `no longer ${stmt}`,
  ]
  return patterns.some(p => changeDesc.includes(p))
}

function checkTaskAlignment(proposedChange: ProposedChange, currentTask: Task | null): DimensionResult {
  if (currentTask === null) {
    return { dimension: 'task_alignment', passed: true, reason: 'No current task — alignment not applicable' }
  }
  const taskDesc = currentTask.description.toLowerCase()
  const changeDesc = getChangeDescription(proposedChange)
  if (taskDesc && !changeDesc) {
    return { dimension: 'task_alignment', passed: false, reason: 'Proposed change has no description but task requires one' }
  }
  return { dimension: 'task_alignment', passed: true, reason: 'Change aligns with task' }
}

function checkWorldModelConsistency(proposedChange: ProposedChange, worldModel: WorldModel | null): DimensionResult {
  if (worldModel === null) {
    return { dimension: 'world_model_consistency', passed: true, reason: 'No world model provided' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const belief of worldModel.beliefs) {
    if (belief.confidence < 0.8) continue
    const stmt = belief.statement.toLowerCase()
    if (isNegation(changeDesc, stmt)) {
      return {
        dimension: 'world_model_consistency',
        passed: false,
        reason: `Change contradicts HIGH-reliability belief: ${JSON.stringify(stmt)}`,
      }
    }
  }
  return { dimension: 'world_model_consistency', passed: true, reason: 'No contradiction with world model beliefs' }
}

function checkOutputContract(proposedChange: ProposedChange, outputContract: OutputContract | null): DimensionResult {
  if (outputContract === null) {
    return { dimension: 'output_contract_precheck', passed: true, reason: 'No output contract provided' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const section of outputContract.required_sections) {
    const s = section.toLowerCase()
    const removalPatterns = [`remove ${s}`, `delete ${s}`, `drop ${s}`, `removes ${s}`]
    if (removalPatterns.some(p => changeDesc.includes(p))) {
      return {
        dimension: 'output_contract_precheck',
        passed: false,
        reason: `Change removes required interface field: ${JSON.stringify(section)}`,
      }
    }
  }
  return { dimension: 'output_contract_precheck', passed: true, reason: 'No required interface fields removed' }
}

function checkCodeQuality(proposedChange: ProposedChange, toolManifest: EvidenceStore | null): DimensionResult {
  if (toolManifest === null) {
    return { dimension: 'code_quality', passed: true, reason: 'No tool manifest — code quality check skipped' }
  }
  const manifest = toolManifest.tool_availability_manifest
  const hasLinter =
    (manifest['linter']?.available ?? false) ||
    (manifest['pylint']?.available ?? false) ||
    (manifest['ruff']?.available ?? false)

  if (!hasLinter) {
    return { dimension: 'code_quality', passed: true, reason: 'No linter available — code quality check skipped' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  if (changeDesc.includes('syntax error') || changeDesc.includes('invalid code')) {
    return { dimension: 'code_quality', passed: false, reason: 'Change description indicates code quality issues' }
  }
  return { dimension: 'code_quality', passed: true, reason: 'Code quality check passed' }
}

function checkHypothesisCompatibility(proposedChange: ProposedChange, hypothesisSet: HypothesisSet | null): DimensionResult {
  if (hypothesisSet === null) {
    return { dimension: 'hypothesis_compatibility', passed: true, reason: 'No hypothesis set provided' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const h of hypothesisSet.active) {
    for (const obs of h.predicted_observations) {
      const obsLower = obs.toLowerCase()
      if (isNegation(changeDesc, obsLower)) {
        return {
          dimension: 'hypothesis_compatibility',
          passed: false,
          reason: `Change contradicts predicted observation: ${JSON.stringify(obs)}`,
        }
      }
    }
  }
  return { dimension: 'hypothesis_compatibility', passed: true, reason: 'Compatible with active hypotheses' }
}

/**
 * Records a single review dimension's outcome into the per-task consecutive-failure counter
 * and derives escalation_triggered from it — the same bookkeeping reviewProposedChange itself
 * uses for its 5 lexical dimensions, exposed so an *additional* check (e.g. a semantic
 * consistency check layered on top — see harness-runtime.ts) gets identical
 * consecutive-failure/escalation treatment instead of a second, divergent mechanism.
 */
export function applyReviewOutcome(
  taskId: string,
  passed: boolean,
  consecutiveFailuresMap: Map<string, number>,
  failedDimension?: DimensionResult,
): ReviewResult {
  if (passed) {
    consecutiveFailuresMap.set(taskId, 0)
    return { passed: true, failed_dimensions: [], consecutive_failures: 0, escalation_triggered: false }
  }
  const prev = consecutiveFailuresMap.get(taskId) ?? 0
  const consec = prev + 1
  consecutiveFailuresMap.set(taskId, consec)
  return {
    passed: false,
    failed_dimensions: failedDimension ? [failedDimension] : [],
    consecutive_failures: consec,
    escalation_triggered: consec >= ESCALATION_THRESHOLD,
  }
}

export function reviewProposedChange(
  proposedChange: ProposedChange,
  currentTask: Task | null,
  worldModel: WorldModel | null,
  outputContract: OutputContract | null,
  hypothesisSet: HypothesisSet | null,
  toolManifest: EvidenceStore | null,
  consecutiveFailuresMap: Map<string, number>,
): ReviewResult {
  const taskId = currentTask?.id ?? 'default'
  const checks: Array<() => DimensionResult> = [
    () => checkTaskAlignment(proposedChange, currentTask),
    () => checkWorldModelConsistency(proposedChange, worldModel),
    () => checkOutputContract(proposedChange, outputContract),
    () => checkCodeQuality(proposedChange, toolManifest),
    () => checkHypothesisCompatibility(proposedChange, hypothesisSet),
  ]

  // Short-circuit on first failure
  for (const check of checks) {
    const result = check()
    if (!result.passed) {
      return applyReviewOutcome(taskId, false, consecutiveFailuresMap, result)
    }
  }

  return applyReviewOutcome(taskId, true, consecutiveFailuresMap)
}
