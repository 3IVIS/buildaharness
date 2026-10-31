import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { AskQuestion } from '@buildaharness/harness';
import { DecomposedTaskSpec } from './decomposition-classifier.js';
import { PlanTaskRecord } from './plan-store.js';
/**
 * P1 of the internal plan — the "plan-drafting revision call" P1's
 * routing (assistant.ts's runTurn, PlanDraftingService) sends every message to while
 * `planMode.active`. Deliberately narrower than P3's eventual version: no tools at all (P3 adds
 * read_file/list_directory grounding for a from-scratch draft — see Section &amp; non-goals),
 * only revises the running draft from conversation text. Kept in its own module, same reasoning
 * plan-builder.ts documents for buildPlanFromTemplate: a single-purpose LLM call, unit-testable
 * without the rest of the drafting plumbing.
 */
export interface PlanDraftTurn {
    /** A short, human-readable summary of the current draft, shown back to the user as the turn's reply. */
    reply: string;
    tasks: DecomposedTaskSpec[];
    successCriteria: string;
    rationale: string;
    /**
     * P2 of the internal plan — true only once the model judges the user
     * has clearly signaled they're satisfied with the current draft and want to proceed, at which
     * point PlanDraftingService hands off to PlanApprovalService instead of returning another plain
     * drafting reply. Defaults false on any malformed/missing value (see parsing below) — a
     * misparsed response must never accidentally fast-track a plan into the approval gate.
     */
    readyForApproval: boolean;
    /**
     * P8 of the internal plan — set only when this revision hit a genuine
     * ambiguity worth pausing on instead of guessing (an ambiguous scope boundary, or a
     * MEDIUM/HIGH-risk branch point with more than one viable approach) — e.g. "which of these two
     * frameworks should the plan target?" A drafting call that sets this always also leaves
     * `readyForApproval` false; `PlanDraftingService.draftTurn` stages it as a nested
     * `needs_clarification` exchange (reusing Q0's `AskQuestion` shape and Q2/Q5/Q6's existing
     * rendering) instead of treating `reply`/`tasks` as an ordinary revision, and the user's answer
     * folds into the *next* drafting call as its `userMessage` rather than resuming a harness run
     * (there is no harness run mid-draft to resume — see plan-drafting-service.ts's doc comment).
     * Absent on every ordinary revision, same "absent when unused" convention the rest of this
     * module follows.
     */
    question?: AskQuestion;
}
/**
 * Spends one real LLM call revising the draft given `userMessage` — same "malformed/incomplete
 * JSON is the expected failure mode, not the edge case" fallback buildPlanFromTemplate uses: any
 * parse failure, or a response with zero usable tasks, returns null (caller keeps the draft
 * unchanged and reports a generic "couldn't update the draft" reply rather than staging garbage).
 */
export declare function draftPlanRevision(llmClient: ILLMClient, userMessage: string, currentTasks: PlanTaskRecord[], currentSuccessCriteria: string, currentRationale: string, model?: string, onUsage?: (usage: TokenUsage) => void, 
/**
 * P3 of the internal plan — grounding text for a from-scratch (no
 * template match) draft, gathered from a bounded read_file/list_directory investigation walk
 * (see AgentLoop.runSupervisorInvestigation, reused rather than building a new search engine —
 * Scope & non-goals) so a code-shaped request's draft can reference real repo state instead of
 * guessing. Absent for every other call (a template-seeded draft, or any revision after the
 * first) — same "absent when unused" convention the rest of this module follows.
 */
groundingContext?: string): Promise<PlanDraftTurn | null>;
