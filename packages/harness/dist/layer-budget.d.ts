import { Budget } from './state/budget.js';
import { PolicyBudget, EscalationLayer } from './layer-policy.js';
import { TurnUserPosture } from './turn-signals.js';
/**
 * AL9a of the adaptive layer selection plan: the per-turn LLM-call budget for escalation layers,
 * built on the existing `Budget` (`maxCalls`). Higher-risk turns and turns where the user has just
 * corrected us get more calls; a routine LOW-risk turn gets few. Only `resolveLayerPolicy` spends
 * it (in priority order) and floor layers never draw on it. Unknown risk is treated as HIGH
 * (fail-safe: an unclassified turn is not starved).
 */
export type BudgetRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export declare const BASE_CALLS_BY_RISK: Readonly<Record<BudgetRiskLevel, number>>;
export declare const POSTURE_CALL_BONUS: Readonly<Record<TurnUserPosture, number>>;
export declare function computeTurnCallBudget(input: {
    riskLevel?: string;
    userPosture?: TurnUserPosture;
}): Budget;
/** The policy's view of a `Budget`'s remaining calls. */
export declare function toPolicyBudget(budget: Budget, priority?: readonly EscalationLayer[]): PolicyBudget;
