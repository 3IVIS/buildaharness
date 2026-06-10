import type { ControlState } from '../state/control-state.js'
import type { StrategyState } from '../state/strategy-state.js'
import { CallerState } from '../state/caller-state.js'
import {
  applyConstraintChangePropagation,
  type ConstraintPropagationContext,
} from './check-caller-updates.js'

export type EscalationReason =
  | 'blocked_state'
  | 'cannot_make_progress'
  | 'budget_exhausted'
  | 'review_failure'
  | 'action_requires_compressed_state'

export interface SurfaceBlocker {
  reason: EscalationReason
  missing_info: string[]
  current_task_summary: string
  escalated_at: string
}

export class EscalationHalt extends Error {
  blocker: SurfaceBlocker

  constructor(blocker: SurfaceBlocker) {
    super(`Escalation halt: ${blocker.reason}`)
    this.name = 'EscalationHalt'
    this.blocker = blocker
  }
}

export function makeSurfaceBlocker(
  reason: EscalationReason,
  missing_info: string[],
  current_task_summary: string,
): SurfaceBlocker {
  return {
    reason,
    missing_info,
    current_task_summary,
    escalated_at: new Date().toISOString(),
  }
}

export function awaitClarification(blocker: SurfaceBlocker): never {
  throw new EscalationHalt(blocker)
}

export function escalateBudgetExhausted(
  stepCount: number,
  maxSteps: number,
): { escalated: true; reason: string; missing_info: string[] } {
  return {
    escalated: true,
    reason: 'budget_exhausted',
    missing_info: [`Step count ${stepCount} reached max_steps limit of ${maxSteps}`],
  }
}

export function escalate(
  _controlState: ControlState,
  _strategyState: StrategyState,
  reason: EscalationReason,
  missingInfo: string[],
  currentTaskSummary: string,
): never {
  const blocker = makeSurfaceBlocker(reason, missingInfo, currentTaskSummary)
  throw new EscalationHalt(blocker)
}

export function handleEscalationResponse(
  callerState: CallerState,
  humanResponse: Record<string, unknown>,
  ctx: ConstraintPropagationContext,
): void {
  callerState.updateConstraints(humanResponse)
  if (callerState.constraints_changed) {
    applyConstraintChangePropagation(callerState, ctx)
  }
}
