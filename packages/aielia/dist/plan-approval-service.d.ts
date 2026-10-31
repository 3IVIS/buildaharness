import { AssistantSession } from './assistant-session.js';
import { PlanService } from './plan-service.js';
import { PlanRecord } from './plan-store.js';
import { AssistantTurnResult } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
/**
 * `'approve_trusted'` (plan mode's P10) is structurally its own decision, not a modifier on
 * `'approve'`/`'approve_with_edits'` — it carries no `edits` of its own and, like plain
 * `'approve'`, activates the plan as staged, just with `PlanRecord.trustApprovedSteps` also set
 * (see resolvePendingPlanApproval below and INV-36).
 */
export type PlanDecision = 'approve' | 'approve_trusted' | 'approve_with_edits' | 'decline';
export interface PlanApprovalEdits {
    cancelTaskIds?: string[];
    editedTasks?: {
        id: string;
        description: string;
    }[];
}
/**
 * `PlanApprovalService.resolvePendingPlanApproval`'s result: either a terminal
 * `AssistantTurnResult` (stale/missing staged plan, no decision supplied, or a failed
 * approve/approve-with-edits — fail closed, `mode` left exactly as staged) or `{ fallThrough:
 * true }`, meaning the plan record has already been updated (activated, or discarded) and
 * `assistant.ts`'s `runTurn` should keep going with the *same originating message* through the
 * ordinary pipeline below, per this phase's own scope: approve lets that pipeline pick up the
 * now-`active` plan exactly the way a freshly template-matched plan already does today
 * (`TurnInterpreter.resolveTasks` -> `loadActivePlan` -> `initialTasks`, regardless of what the
 * message itself says, short of a cancel/abandon match) — no new execution-driving code needed,
 * just reusing what already runs a plan's first task the moment it becomes `active`. Decline
 * falls through the same way, but with no plan active at all.
 */
export type PlanApprovalOutcome = {
    fallThrough: true;
} | AssistantTurnResult;
/**
 * Owns plan mode's P2 mandatory whole-plan approval gate — mirrors ActionApprovalService's
 * "resolved by ID, never re-derived" staging pattern (T4 of the file-tools plan), the same model
 * AskClarificationService (Q2) already follows. Every drafted plan passes through here exactly
 * once, regardless of risk (Section 5b-2: no risk-tiered skip) — `PlanDraftingService` calls
 * `stageAndRespond` the moment a revision's `readyForApproval` is true, and
 * `assistant.ts`'s `runTurn` calls `resolvePendingPlanApproval` whenever a turn carries a
 * `planApprovalId`, before `planMode.active` is even checked (mirrors where `pendingActionId`/
 * `pendingClarificationId` are checked).
 */
export declare class PlanApprovalService {
    private readonly planService;
    private readonly session;
    private readonly onTrace;
    constructor(planService: PlanService, session: AssistantSession, onTrace: ((event: TraceEvent) => void) | undefined);
    /** Stages `plan` for approval and returns the `needs_plan_approval` result — the PlanDraftingService counterpart to AskClarificationService.stageAndRespond. */
    stageAndRespond(sessionId: string, transcriptKey: string, plan: PlanRecord, userMessage: string): Promise<AssistantTurnResult>;
    /**
     * Resolves a staged plan by ID — validates it's still exactly the plan that was staged (a
     * stale/unknown `planApprovalId` resolves to a no-op `ok`, same as
     * AskClarificationService.resolvePendingClarification's own stale-ID handling), then applies
     * the caller's decision. Fail-closed (Protected Invariants) on every failure path: no decision,
     * or a throwing edit/activation step, leaves `mode: 'awaiting_approval'` untouched and returns a
     * new `needs_plan_approval` result rather than silently advancing or discarding the plan.
     */
    resolvePendingPlanApproval(sessionId: string, planApprovalId: string, decision: PlanDecision | undefined, edits: PlanApprovalEdits | undefined, threadId?: string): Promise<PlanApprovalOutcome>;
}
