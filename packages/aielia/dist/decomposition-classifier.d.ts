import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * True if `message` looks like an enumeration of multiple distinct items — the strong signals
 * above (sequencing markers, comma/semicolon/numbered lists), deliberately WITHOUT a word-count
 * fallback: a single long reminder isn't multiple reminders just because it's wordy. Used by
 * risk-classifier.ts to gate bulk reminder creation on confirmation instead of letting the model
 * silently create several reminders in one turn.
 */
export declare function looksLikeEnumeratedItems(message: string): boolean;
/** The raw lexical enumeration check, used inside `classifyRisk`'s bulk-reminder gate — which is itself switched by lexicalMode's `risk` family. */
export declare function looksLikeEnumeratedItemsLexical(message: string): boolean;
export interface DecomposedTaskSpec {
    id: string;
    description: string;
    depends_on: string[];
    /**
     * Per-task risk (LOW/MEDIUM/HIGH), not the turn-level risk broadcast across every task —
     * see Phase 4.2 of the harness layer activation plan: a step like "delete the draft file"
     * shouldn't inherit an unrelated sibling step's risk profile just because they were rendered
     * from the same turn. classifyTurnIntent's LLM call judges this directly for ad hoc
     * decompositions; buildPlanFromTemplate (plan-builder.ts) attaches it from the template's own
     * already-curated per-task risk_level instead of asking the LLM to re-derive it.
     */
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}
/**
 * Reframes a single-task turn's description to lead with its subject — the same phrasing
 * classifyTurnIntent's own decomposedTasks and buildPlanFromTemplate (plan-builder.ts) already
 * produce for their own tasks, applied here for the much more common case where a turn goes
 * through neither: an ad hoc single-task turn whose description otherwise stays the raw verbatim userMessage (see
 * assistant.ts's initialTasks fallback). Without this, only decomposed/planned tasks got
 * subject-first descriptions, so the "Completed: <description>" belief statementsOpposed/
 * isNegation compare against was structured for some tasks and not others. Deliberately not
 * called unconditionally — the caller gates this behind looksLikeCodingFact AND riskLevel !==
 * 'LOW' (the actual precondition for a single task's description to ever reach that belief; see
 * assistant.ts's call site for why looksLikeCodingFact alone isn't a safe gate for a new call).
 * Falls back to null (caller keeps the original message) on any parse failure or LLM error,
 * matching this codebase's other LLM-backed classifiers.
 */
export declare function reframeTaskDescriptionWithLLM(message: string, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<string | null>;
