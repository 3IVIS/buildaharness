import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * P9 of the internal plan — the lightweight plan-sketch delegate's one
 * bounded LLM call. Deliberately the cheapest possible shape: a single plain-text reply the
 * caller shows directly in the chat, not a structured task list staged anywhere — there is no
 * PlanRecord, no PlanTaskRecord, nothing for P2's approval gate to see (INV-35). Distinct from
 * plan-drafting.ts's draftPlanRevision, which is the first call in an iterative, stateful,
 * eventually-approved drafting loop; this is one-shot advice, thrown away the moment the reply
 * is shown — there is no "revise the sketch" follow-up call, no running draft to revise.
 */
export interface PlanSketchResult {
    reply: string;
}
/**
 * Spends one real LLM call sketching a plan for `request` — same "malformed/incomplete output is
 * the expected failure mode, not the edge case" fallback plan-drafting.ts's draftPlanRevision
 * uses: any thrown error, or an empty reply, returns null so the caller can show a generic
 * "couldn't sketch that" message instead of an empty bubble.
 */
export declare function sketchPlan(llmClient: ILLMClient, request: string, groundingContext: string | undefined, model: string | undefined, onUsage: ((usage: TokenUsage) => void) | undefined): Promise<PlanSketchResult | null>;
