import { Budget } from './state/budget.js'
import type { PolicyBudget, EscalationLayer } from './layer-policy.js'
import type { TurnUserPosture } from './turn-signals.js'

/**
 * AL9a of the adaptive layer selection plan: the per-turn LLM-call budget for escalation layers,
 * built on the existing `Budget` (`maxCalls`). Higher-risk turns and turns where the user has just
 * corrected us get more calls; a routine LOW-risk turn gets few. Only `resolveLayerPolicy` spends
 * it (in priority order) and floor layers never draw on it. Unknown risk is treated as HIGH
 * (fail-safe: an unclassified turn is not starved).
 */
export type BudgetRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'

export const BASE_CALLS_BY_RISK: Readonly<Record<BudgetRiskLevel, number>> = { LOW: 3, MEDIUM: 5, HIGH: 8, UNKNOWN: 8 }
export const POSTURE_CALL_BONUS: Readonly<Record<TurnUserPosture, number>> = {
  corrective: 2, directive: 0, exploratory: 0, informational: 0, unknown: 0,
}

export function computeTurnCallBudget(input: { riskLevel?: string; userPosture?: TurnUserPosture }): Budget {
  const risk = (input.riskLevel && input.riskLevel in BASE_CALLS_BY_RISK ? input.riskLevel : 'UNKNOWN') as BudgetRiskLevel
  const bonus = input.userPosture ? (POSTURE_CALL_BONUS[input.userPosture] ?? 0) : 0
  return new Budget({ maxCalls: BASE_CALLS_BY_RISK[risk] + bonus })
}

/** The policy's view of a `Budget`'s remaining calls. */
export function toPolicyBudget(budget: Budget, priority?: readonly EscalationLayer[]): PolicyBudget {
  const remaining = budget.remaining('calls')
  return { remainingCalls: Number.isFinite(remaining) ? remaining : null, priority }
}
