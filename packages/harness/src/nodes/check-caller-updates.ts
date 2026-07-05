import type { WorldModel } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import { TaskGraph, type Task } from '../state/task-graph.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { ControlStateResolverFn } from '../generation-id.js'
import { CallerState, updateSuccessCriteria } from '../state/caller-state.js'
import { OutputContract, updateOutputContract } from '../state/output-contract.js'
import { detectContradictions } from './detect-contradictions.js'

export const RESTART_ITERATION = 'RESTART_ITERATION' as const
export type UpdateCheckResult = typeof RESTART_ITERATION | 'NO_UPDATE'

export interface CallerUpdate {
  pending_update: Record<string, unknown>
  constraints_changed: boolean
}

export interface UpdateChannel {
  poll(): CallerUpdate | null
}

export class NoOpUpdateChannel implements UpdateChannel {
  poll(): CallerUpdate | null {
    return null
  }
}

export interface ConstraintPropagationContext {
  worldModel: WorldModel
  hypothesisSet: HypothesisSet
  taskGraph: TaskGraph
  diagnostics: Diagnostics
  failureDiagnostics: FailureDiagnostics
  evidenceStore?: EvidenceStore
  outputContract?: OutputContract
}

function taskInScope(task: Task, criteriaTokens: Array<Set<string>>): boolean {
  const descTokens = new Set(task.description.toLowerCase().split(/\s+/))
  return criteriaTokens.some(tokens => [...descTokens].some(t => tokens.has(t)))
}

function criterionCovered(criterionTokens: Set<string>, taskGraph: TaskGraph): boolean {
  for (const task of taskGraph.tasks) {
    if (task.status === 'COMPLETE') continue
    if (task.status === 'BLOCKED' && task.block_reason === 'scope_eliminated') continue
    const descTokens = new Set(task.description.toLowerCase().split(/\s+/))
    if ([...descTokens].some(t => criterionTokens.has(t))) return true
  }
  return false
}

/**
 * Matches adapter/harness/constraint_propagation.py's revalidate_task_graph(): blocks
 * non-complete tasks that fall outside the updated success criteria's scope, and adds
 * new PENDING tasks for criteria no active/pending task already covers.
 */
export function revalidateTaskGraph(taskGraph: TaskGraph, callerState: CallerState): TaskGraph {
  const updatedCriteria = [...new Set(callerState.success_criteria)]
  if (updatedCriteria.length === 0) return taskGraph

  const criteriaTokenSets = updatedCriteria.map(c => new Set(c.toLowerCase().split(/\s+/)))

  for (const task of taskGraph.tasks) {
    if (task.status === 'COMPLETE') continue
    if (!taskInScope(task, criteriaTokenSets)) {
      if (task.status !== 'BLOCKED' || task.block_reason !== 'scope_eliminated') {
        task.status = 'BLOCKED'
        task.block_reason = 'scope_eliminated'
        taskGraph.changed = true
      }
    }
  }

  for (const criterion of updatedCriteria) {
    const criterionTokens = new Set(criterion.toLowerCase().split(/\s+/))
    if (!criterionCovered(criterionTokens, taskGraph)) {
      taskGraph.tasks.push({
        id: `task-${Math.random().toString(36).slice(2, 10)}`,
        description: criterion,
        status: 'PENDING',
        risk_level: 'MEDIUM',
        depends_on: [],
        parallel_write_domains: [],
        abstraction_level: 1,
        assigned_strategy: null,
      })
      taskGraph.changed = true
    }
  }

  return taskGraph
}

/**
 * Matches adapter/harness/constraint_propagation.py's apply_constraint_change_propagation():
 * the single shared entry point for both checkCallerUpdates() and the escalation response
 * handler whenever a caller constraint update arrives. Runs, in order: stale-belief flagging,
 * contradiction re-detection (merged without duplicates), output-contract re-derivation, and
 * task-graph scope revalidation. The caller is responsible for incrementing generation_id and
 * re-resolving control_state after this returns.
 */
export function applyConstraintChangePropagation(
  callerState: CallerState,
  ctx: ConstraintPropagationContext,
  _resolverFn?: ControlStateResolverFn,
): void {
  // 1. Flag beliefs stale relative to updated success criteria
  updateSuccessCriteria(callerState, ctx.worldModel)

  // 2. Re-detect contradictions on the updated belief set; merge without duplicates.
  // detectContradictions() pushes straight into worldModel.contradictions (unlike Python's
  // version, which returns a list for the caller to merge), so re-running it here can
  // re-add ids already present — dedupe by id afterwards, keeping the first occurrence.
  const evidenceStore = ctx.evidenceStore ?? ({ observations: [], tool_availability_manifest: {}, tool_reliability_envelopes: {}, isToolAvailable: () => true } as unknown as EvidenceStore)
  detectContradictions(ctx.worldModel, evidenceStore, ctx.hypothesisSet)
  const seen = new Set<string>()
  ctx.worldModel.contradictions = ctx.worldModel.contradictions.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })

  // 3. Re-derive output contract from updated constraints (immutable update, copied back in-place)
  if (ctx.outputContract) {
    const newOc = updateOutputContract(callerState, ctx.outputContract)
    ctx.outputContract.caller_specific_constraints = newOc.caller_specific_constraints
    ctx.outputContract.required_interface_fields = newOc.required_interface_fields
  }

  // 4. Revalidate task graph (mutates in-place)
  revalidateTaskGraph(ctx.taskGraph, callerState)

  ctx.worldModel.generation_id++
  callerState.resetConstraintsChanged()
}

export function checkCallerUpdates(
  callerState: CallerState,
  updateChannel: UpdateChannel,
  ctx?: ConstraintPropagationContext,
  resolverFn?: ControlStateResolverFn,
): UpdateCheckResult {
  const update = updateChannel.poll()
  if (update === null) return 'NO_UPDATE'

  // inject_clarification + caller_state.update()
  callerState.updateConstraints(update.pending_update)

  if (callerState.constraints_changed) {
    if (ctx) {
      applyConstraintChangePropagation(callerState, ctx, resolverFn)
    } else {
      callerState.resetConstraintsChanged()
    }
    return RESTART_ITERATION
  }

  return 'NO_UPDATE'
}
