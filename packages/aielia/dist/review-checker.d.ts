import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { BeliefCandidate } from './contradiction-checker.js';
/**
 * `AUDIT_SEMANTIC_CHANGE_REVIEW` gate — feature-value audit (Phase C2 of the internal plan).
 * Default **ON**: the semantic change-reviewer LLM call ships enabled, so an unset / empty / truthy
 * value keeps today's behaviour. Set to a falsy value (`0` / `false` / `off` / `no` / `disabled`)
 * to skip the hook entirely, leaving `reviewProposedChange`'s lexical `isNegation` check as the
 * only conflict check. Read at exactly one call site — `harness-bridge.ts`, where the
 * `semanticChangeReviewer` host hook is wired. Same shape as `semanticContradictionEnabled()`
 * (contradiction-checker.ts).
 */
export declare function semanticChangeReviewEnabled(env?: Record<string, string | undefined>): boolean;
/** Marks a steering note as coming from the change reviewer rather than from the user — agent-loop.ts gives it its own header so the proposer isn't told the user said it. */
export declare const REVIEW_NOTE_PREFIX = "[review] ";
/** The user-facing line for a conflict the reviewer found — see AssistantTurnResult.reviewNotice. */
export declare function reviewNoticeText(reasons: string[]): string;
/**
 * One LLM call checking a proposed change against everything relevant at once (never one call
 * per belief/prediction) — layered on top of review-proposed-change.ts's lexical `isNegation`
 * check, which only catches an explicit phrase like "not X"/"removes X"/"no longer X". That check
 * also requires the change description and the belief it's compared against to share a concrete
 * subject before it fires (see looksLikeCodingFact's doc comment in contradiction-checker.ts) —
 * which is why decomposition-classifier.ts and plan-builder.ts prompt task descriptions to lead
 * with their subject. A
 * paraphrased conflict ("we're dropping the login feature" vs. a belief that login is required)
 * slips past that phrase list entirely. It runs for every change, coding-shaped or not: it used to
 * skip a description that looked like a coding action on the theory that the lexical check
 * covers that domain, but that gate was a keyword list ("build", "test"…) that also matched
 * ordinary requests ("Build the offsite catering plan…"), and the lexical checks are being rolled
 * back — the semantic check must not depend on them. The host only wires this when there is a
 * trusted fact or prediction to check against, which is what bounds its cost. Falls back to "no conflict" on any parse
 * failure or LLM error, matching this codebase's other LLM-backed classifiers — a missed conflict
 * costs nothing worse than the lexical-only behavior this is layered on top of.
 */
export declare function checkSemanticReviewConflict(changeDescription: string, highConfidenceBeliefs: BeliefCandidate[], hypothesisPredictions: string[], llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    conflict: boolean;
    reason?: string;
}>;
