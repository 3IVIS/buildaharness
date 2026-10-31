import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { PlanTaskRecord } from './plan-store.js';
/**
 * P6 of the internal plan — runs between drafting (P1/P3) and staging
 * for approval (P2). Two independent checks, deliberately ordered cheapest-and-most-certain
 * first: (1) dependency-graph validity (pure, synchronous, no LLM call — the same three checks
 * `adapter/harness/task_graph.py`'s `validate_task_graph` runs Python-side: orphaned `depends_on`
 * references and cycle detection via the identical iterative-DFS WHITE/GRAY/BLACK algorithm, plus
 * a duplicate-task-id check this phase's Scope calls for that the Python original doesn't need
 * because `TaskGraph` construction already dedupes by id), then (2) one bounded LLM call for the
 * harder judgment — a lighter, narrower version of `reviewer.py`'s three-lens shape, specifically
 * the adversarial lens's question. A graph error is a fails-fast condition (the plan must not
 * reach `awaiting_approval` with an invalid structure); an LLM-lens failure is not — it just means
 * the plan proceeds to approval without `reviewNotes` (Validation section, LLM-failure fallback).
 */
export declare function validatePlanTaskGraph(tasks: PlanTaskRecord[]): string[];
export type PlanVerificationOutcome = {
    kind: 'graph_invalid';
    errors: string[];
} | {
    kind: 'verified';
    reviewNotes: string[];
    verifiedAt: string;
};
/**
 * Deterministic checks first (fails fast on a structural problem — the caller must not stage a
 * plan whose graph is invalid), then the bounded adversarial-completeness LLM call. Called from
 * `PlanDraftingService.draftTurn` right before handing a `readyForApproval` draft to
 * `PlanApprovalService.stageAndRespond`.
 */
export declare function verifyPlanDraft(llmClient: ILLMClient, tasks: PlanTaskRecord[], successCriteria: string, rationale: string, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<PlanVerificationOutcome>;
