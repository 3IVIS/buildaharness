import { AskQuestion } from '@buildaharness/harness';
import { AssistantTurnResult } from './assistant-types.js';
import { NextStepSuggestion } from './next-step-proposer.js';
/**
 * What to show for a finished turn, decided once for every surface. The CLI prints it and chat-ui renders it as
 * cards; neither re-reads the status branches of AssistantTurnResult. Hints are data, not formatted strings,
 * because the CLI prints them inline and the apps render them as elements.
 */
export declare const DEFAULT_APPROVAL_REASON = "This action needs approval.";
export declare const DEFAULT_ESCALATION_REASON = "Aielia halted and needs more information.";
export declare const DEFAULT_CLARIFICATION_REASON = "This request needs clarification.";
export declare const MISSING_PLAN_APPROVAL_ID_REASON = "A plan is awaiting approval, but its approval id is missing.";
type PendingActionKind = NonNullable<AssistantTurnResult['pendingActionKind']>;
/** Label and question for a staged action's approval. No kind means a plain write (the original, default pause). */
export declare function approvalLabels(kind: PendingActionKind | undefined): {
    kindLabel: string;
    promptText: string;
};
/** The "No harness trace" explanations for /why and /layers, one place so every surface words each case the same. */
export declare const NO_TRACE: {
    readonly fastPath: "No harness trace — the last turn was a simple, self-contained question answered directly without activating the harness (fast path).";
    readonly stagedAction: (kindLabel: string, resolution?: "approved" | "declined") => string;
    readonly messageApproval: (resolution?: "approved" | "declined") => string;
    readonly planApproval: (resolution?: "approved" | "declined", pendingHint?: string) => string;
    readonly clarification: (unanswerableReason?: string) => string;
    readonly escalated: (reason: string | undefined) => string;
    readonly stopped: "No harness trace — the last turn was stopped before it finished.";
    readonly failed: "No harness trace — the last turn failed with an error.";
};
export interface TurnHints {
    /** Number of sources the turn consulted (shown as "N sources — /sources"). */
    sourcesCount?: number;
    /** Plan completion, 0–100, when a plan is active. */
    planCompletionPct?: number;
    contradictionNotice?: string;
    reviewNotice?: string;
    auditNotice?: string;
    /** Set when a turn was paused part-way; appended after the streamed reply. */
    pausedNote?: string;
    nextSteps?: NextStepSuggestion[];
}
export type TurnPresentation = {
    kind: 'reply';
    text: string;
    riskLevel?: AssistantTurnResult['riskLevel'];
    hints: TurnHints;
    noTraceReason?: string;
} | {
    kind: 'approval';
    /** 'action': a staged write/shell/email/batch/revert (resume with pendingActionId). 'message': the message-level risk gate. */
    scope: 'action' | 'message';
    reason: string;
    riskLevel?: AssistantTurnResult['riskLevel'];
    pendingActionId?: string;
    pendingActionKind?: PendingActionKind;
    kindLabel?: string;
    promptText?: string;
    noTraceReason: string;
} | {
    kind: 'clarification';
    questions: AskQuestion[];
    pendingClarificationId: string;
    riskLevel?: AssistantTurnResult['riskLevel'];
    noTraceReason: string;
} | {
    kind: 'plan_approval';
    planApprovalId: string;
    /** Absent when the harness staged a plan but did not hand over its tasks; a surface that needs them to render may treat that as an escalation. */
    planApproval?: AssistantTurnResult['planApproval'];
    reason?: string;
    riskLevel?: AssistantTurnResult['riskLevel'];
    noTraceReason: string;
} | {
    kind: 'escalation';
    reason: string;
    noTraceReason: string;
} | {
    kind: 'cancelled';
    noTraceReason: string;
};
/**
 * Maps a turn result to what every surface shows. `pendingActionId` on the *request* (a resumed staged action)
 * is the surface's business, not this function's: a resumed turn's result is still presented as a reply.
 */
export declare function presentTurnResult(result: AssistantTurnResult): TurnPresentation;
export {};
