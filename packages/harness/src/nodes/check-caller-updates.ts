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
  /**
   * Widened in Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html to allow an async
   * result — the scope×urgency classifier (packages/aielia/src/scope-urgency-classifier.ts) needs
   * a real LLM call to turn a drained steering message into a CallerUpdate, which a synchronous
   * poll() can't do. checkCallerUpdates() below awaits this, so a synchronous implementation
   * (NoOpUpdateChannel, OneShotAnswerChannel) keeps working completely unchanged — `await` on a
   * non-Promise value just resolves it immediately.
   */
  poll(): CallerUpdate | null | Promise<CallerUpdate | null>
}

export class NoOpUpdateChannel implements UpdateChannel {
  poll(): CallerUpdate | null {
    return null
  }
}

/**
 * Generic async-producer UpdateChannel — wraps any `() => Promise<CallerUpdate | null>` function.
 * Deliberately free of any goal-graph/steering-specific concept (those live in aielia's
 * goal-graph-reconcile.ts, Phase 4) so this stays a reusable piece of the harness's own public
 * UpdateChannel shape, the same way NoOpUpdateChannel is.
 */
export class AsyncFnUpdateChannel implements UpdateChannel {
  constructor(private readonly fn: () => Promise<CallerUpdate | null>) {}
  poll(): Promise<CallerUpdate | null> {
    return this.fn()
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
 * Phase 4 (R4's CANCEL_CURRENT branch): blocks every non-terminal task rather than revalidating
 * against success_criteria — a cancellation isn't a scope change to re-derive tasks from, it's an
 * explicit stop. Mirrors revalidateTaskGraph's BLOCKED/block_reason shape (distinct reason string
 * so this is never confused with an ordinary scope_eliminated narrowing) so downstream code that
 * already reads block_reason keeps working unchanged.
 */
export function cancelTaskGraph(taskGraph: TaskGraph): void {
  for (const task of taskGraph.tasks) {
    if (task.status === 'COMPLETE' || task.status === 'FAILED') continue
    if (task.status === 'BLOCKED' && task.block_reason === 'goal_cancelled') continue
    task.status = 'BLOCKED'
    task.block_reason = 'goal_cancelled'
    taskGraph.changed = true
  }
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

export async function checkCallerUpdates(
  callerState: CallerState,
  updateChannel: UpdateChannel,
  ctx?: ConstraintPropagationContext,
  resolverFn?: ControlStateResolverFn,
): Promise<UpdateCheckResult> {
  const update = await updateChannel.poll()
  if (update === null) return 'NO_UPDATE'

  // inject_clarification + caller_state.update()
  callerState.updateConstraints(update.pending_update)

  if (callerState.constraints_changed) {
    if (ctx) {
      // Phase 4 (R4's CANCEL_CURRENT branch): an explicit stop signal, not an ordinary
      // constraint/criteria update — bypasses revalidateTaskGraph (which reasons about
      // success_criteria, untouched here) in favor of cancelTaskGraph's blanket block.
      if (update.pending_update.cancel_current === true) {
        cancelTaskGraph(ctx.taskGraph)
        ctx.worldModel.generation_id++
        callerState.resetConstraintsChanged()
      } else {
        applyConstraintChangePropagation(callerState, ctx, resolverFn)
      }
    } else {
      callerState.resetConstraintsChanged()
    }
    return RESTART_ITERATION
  }

  return 'NO_UPDATE'
}
