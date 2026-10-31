import { ControlState } from '../state/control-state.js';
import { StrategyState } from '../state/strategy-state.js';
import { CallerState } from '../state/caller-state.js';
import { ConstraintPropagationContext } from './check-caller-updates.js';
export type EscalationReason = 'blocked_state' | 'cannot_make_progress' | 'budget_exhausted' | 'review_failure' | 'action_requires_compressed_state' | 'supervisor_question';
export declare const MAX_QUESTIONS_PER_BATCH = 4;
export declare const MIN_OPTIONS_PER_QUESTION = 2;
export declare const MAX_OPTIONS_PER_QUESTION = 4;
export interface AskQuestionOption {
    label: string;
    description?: string;
    preview?: string;
    recommended?: boolean;
}
export interface AskQuestion {
    id: string;
    header?: string;
    question: string;
    options?: AskQuestionOption[];
    allowMultiple?: boolean;
    allowFreeText?: boolean;
}
export type AskAnswer = {
    questionId: string;
    kind: 'selected';
    selectedLabels: string[];
} | {
    questionId: string;
    kind: 'selected_with_edit';
    selectedLabels: string[];
    editText: string;
} | {
    questionId: string;
    kind: 'free_text';
    freeText: string;
};
export interface AskResponse {
    answers: AskAnswer[];
}
export declare function validateAskQuestion(q: AskQuestion): void;
/**
 * Validate a batch of questions against INV-34's per-batch cap. Each AskQuestion
 * should already be valid on its own (validateAskQuestion); this only enforces
 * the batch-level MAX_QUESTIONS_PER_BATCH ceiling. Raises loudly rather than
 * silently truncating.
 */
export declare function makeQuestionsBatch(questions: AskQuestion[]): AskQuestion[];
/**
 * Validate one AskAnswer's internal shape — `kind` determines which of
 * selectedLabels/editText/freeText is populated, so a payload can never mix
 * shapes (e.g. a `free_text` answer carrying `selectedLabels`).
 */
export declare function validateAskAnswer(answer: AskAnswer): void;
/**
 * Cross-check a resolve payload against the batch of questions it answers.
 * Every question must have exactly one matching answer; an allowMultiple: false
 * question must not receive more than one selected label. Throws on the first
 * violation found — used by callers resolving a batch (Q2/Q3), not by
 * AskAnswer/AskQuestion construction themselves.
 */
export declare function validateAskResponse(questions: AskQuestion[], response: AskResponse): void;
/**
 * Split ranked candidates into a first batch (top `cap`) and an ordered deferred
 * remainder. `candidates` must already be ranked by the caller (most
 * plan-changing first) — this only enforces INV-34's per-batch cap, it does not
 * rank (INV-37).
 */
export declare function batchQuestions(candidates: AskQuestion[], cap?: number): {
    batch: AskQuestion[];
    deferred: AskQuestion[];
};
/**
 * Re-evaluate a deferred list after folding in an earlier batch's answers.
 * `isMoot` is caller-supplied domain logic (e.g. "does batch one's answer
 * already resolve this question") — this only filters and re-applies INV-34's
 * cap (INV-37); it never decides mootness itself.
 */
export declare function refineDeferredBatch(deferred: AskQuestion[], isMoot: (q: AskQuestion) => boolean, cap?: number): AskQuestion[];
export interface SurfaceBlocker {
    reason: EscalationReason;
    missing_info: string[];
    current_task_summary: string;
    escalated_at: string;
    question?: string;
    options?: string[];
    questions?: AskQuestion[];
}
export declare class EscalationHalt extends Error {
    blocker: SurfaceBlocker;
    constructor(blocker: SurfaceBlocker);
}
export declare function makeSurfaceBlocker(reason: EscalationReason, missing_info: string[], current_task_summary: string, questions?: AskQuestion[]): SurfaceBlocker;
export declare function awaitClarification(blocker: SurfaceBlocker): never;
export declare function escalateBudgetExhausted(stepCount: number, maxSteps: number): {
    escalated: true;
    reason: string;
    missing_info: string[];
};
export declare function escalate(_controlState: ControlState, _strategyState: StrategyState, reason: EscalationReason, missingInfo: string[], currentTaskSummary: string): never;
export declare function handleEscalationResponse(callerState: CallerState, humanResponse: Record<string, unknown>, ctx: ConstraintPropagationContext): void;
