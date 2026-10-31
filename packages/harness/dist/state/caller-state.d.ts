import { z } from 'zod';
import { AskAnswer, AskQuestion } from '../nodes/escalate.js';
/**
 * Q4 (the internal plan) — renders one AskAnswer as a distinct,
 * kind-tagged constraint line so a "selected" pick, a "selected_with_edit" pick-plus-caveat,
 * and a "free_text" answer never collapse into one indistinguishable joined string once they
 * reach current_constraints. Kept separate from ask-clarification-service.ts's own
 * transcript-facing formatAnswer() (a distinct, human-chat-message concern) even though the
 * shape of the logic is similar.
 */
export declare function describeAskAnswer(question: AskQuestion | undefined, answer: AskAnswer): string;
export declare const CallerStateSchema: z.ZodObject<{
    current_constraints: z.ZodArray<z.ZodString, "many">;
    clarification_history: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">;
    last_update: z.ZodString;
    output_preferences: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    success_criteria: z.ZodArray<z.ZodString, "many">;
    constraints_changed: z.ZodBoolean;
    escalation_pending: z.ZodBoolean;
    pending_clarification: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    current_constraints: string[];
    clarification_history: Record<string, unknown>[];
    last_update: string;
    output_preferences: Record<string, unknown>;
    success_criteria: string[];
    constraints_changed: boolean;
    escalation_pending: boolean;
    pending_clarification: Record<string, unknown> | null;
}, {
    current_constraints: string[];
    clarification_history: Record<string, unknown>[];
    last_update: string;
    output_preferences: Record<string, unknown>;
    success_criteria: string[];
    constraints_changed: boolean;
    escalation_pending: boolean;
    pending_clarification: Record<string, unknown> | null;
}>;
export type CallerStateData = z.infer<typeof CallerStateSchema>;
export declare class CallerState {
    current_constraints: string[];
    clarification_history: Record<string, unknown>[];
    last_update: string;
    output_preferences: Record<string, unknown>;
    success_criteria: string[];
    constraints_changed: boolean;
    escalation_pending: boolean;
    pending_clarification: Record<string, unknown> | null;
    constructor(data?: Partial<CallerStateData>);
    /**
     * Matches adapter/harness/caller_state.py's inject_clarification(): the single write
     * path for caller updates. Always appends the raw update to clarification_history
     * (never truncated); current_constraints/success_criteria are replaced wholesale
     * when present, output_preferences is merged.
     *
     * Q4 — a `clarification_answers` key (an AskResponse's answers, as set by
     * AskClarificationService's OneShotAnswerChannel / the adapter's escalation-resume
     * endpoint) is handled distinctly from a plain `current_constraints` replacement: each
     * AskAnswer is rendered via describeAskAnswer() (kind-tagged — a bare "selected" pick
     * reads differently from "selected_with_edit"'s caveat or a "free_text" answer) and
     * *appended* to current_constraints, using the optional `ask_questions` list (the
     * original AskQuestion batch) to resolve question text where available.
     */
    updateConstraints(update: Record<string, unknown>): void;
    resetConstraintsChanged(): void;
    toJSON(): CallerStateData;
    static fromJSON(json: CallerStateData): CallerState;
}
interface BeliefLike {
    id: string;
    statement: string;
}
interface WorldModelLike {
    beliefs: BeliefLike[];
    stale_flags: Record<string, boolean>;
}
/**
 * Matches adapter/harness/caller_state.py's update_success_criteria(): flags beliefs
 * stale (never deletes) when their statement shares no token with any success criterion.
 */
export declare function updateSuccessCriteria(callerState: CallerState, worldModel: WorldModelLike): void;
export {};
