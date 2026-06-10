import type { WorldModel } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { TaskGraph } from '../state/task-graph.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { ControlStateResolverFn } from '../generation-id.js'
import { CallerState } from '../state/caller-state.js'

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
}

// Shared entry point for constraint propagation — used identically by checkCallerUpdates
// and by the P10 escalation path (same code, not two implementations).
export function applyConstraintChangePropagation(
  callerState: CallerState,
  ctx: ConstraintPropagationContext,
  _resolverFn?: ControlStateResolverFn,
): void {
  // detect_contradictions, update_success_criteria, update_output_contract,
  // revalidate_task_graph all feed into the generation_id increment that signals
  // downstream nodes to re-read fresh state.
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
