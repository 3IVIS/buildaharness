import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { GoalThread } from './goal-graph-store.js';
import { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js';
import { NextStepContext } from './next-step-context.js';
export type SuggestionConfidence = 'high' | 'medium' | 'low';
/** Mirrors `shouldAutoPromote()`'s three-way policy *shape* (memory-service.ts) — not its bands, since Q10 found no numeric threshold to reuse: `high` auto-promotes, `medium` queues for explicit confirmation, `low` stays advisory-only and is never persisted past the turn that produced it. */
export type SuggestionPromotion = 'auto' | 'pending_confirm' | 'session_only';
export interface NextStepSuggestion {
    /** A concrete, actionable next step description — third person, e.g. "add tests for the login page". */
    description: string;
    confidence: SuggestionConfidence;
    /** Why this follows from the completed goal — surfaced to the user alongside the suggestion, same spirit as StatedFact's rationale-free text but here always populated since a suggestion needs justification a stated fact doesn't. */
    rationale: string;
}
/**
 * A persistent advisory node (R7) — `proposeNextSteps()`'s per-suggestion output, carrying the
 * promotion decision alongside the LLM's own judgment. Self-contained rather than a
 * `GoalTaskRecord`: a suggestion isn't yet a task on any thread (it may never be promoted at all,
 * see `session_only`), so it deliberately doesn't reuse that shape.
 */
export interface SuggestedNextStepNode {
    id: string;
    goalThreadId: string;
    description: string;
    rationale: string;
    confidence: SuggestionConfidence;
    promotion: SuggestionPromotion;
    createdAt: string;
}
/**
 * Names the language the suggestions must be written in. The model drifted into Chinese, Spanish or French
 * on English conversations when it was only told to "match the user's language", so English is named
 * outright when the user's own text clearly is English (two distinct common English words); anything else
 * keeps the generic instruction.
 */
export declare function suggestionLanguage(userTexts: string[]): string;
/** Q10's three-way policy shape, applied to this mechanism's own confidence rubric — see this module's doc comment on why the bands aren't reused from `shouldAutoPromote()`. */
export declare function classifySuggestionPromotion(confidence: SuggestionConfidence): SuggestionPromotion;
/**
 * Tier 1.5's entry point (R7): proposes next-step nodes for `thread`, gated by
 * `goalGraphSuggestMode` independently of `goalGraphMode` (Q8) — returns `[]` without any LLM call
 * both when the flag is off (INV-43: a flag-off session sees zero behavior change) and when
 * `thread` hasn't actually reached `DONE` yet, since a suggestion only makes sense once the goal
 * it follows from is finished.
 */
export declare function proposeNextSteps(thread: GoalThread, llmClient: ILLMClient, suggestMode: GoalGraphSuggestMode, model?: string, onUsage?: (usage: TokenUsage) => void, bigPicture?: NextStepContext): Promise<SuggestedNextStepNode[]>;
/**
 * The turn-end entry point: after a full (non-trivial) turn completes, propose up to three
 * concrete next steps for the user to pick from — shown under the reply, like Claude Code's prompt
 * suggestions. Same bounded call and confidence rubric as `proposeNextSteps` (the turn's request
 * stands in for the thread's success criteria, the reply for its rationale), gated by
 * `goalGraphSuggestMode`. Returns `[]` without any LLM call when the mode isn't 'enabled' or there
 * is nothing to follow up on. Ordered most-confident first and capped at three; unlike thread
 * suggestions nothing here is persisted — a turn-end option is advisory for the turn that produced
 * it, so every confidence tier (including `low`, `session_only` in the thread policy) is shown.
 */
export declare function proposeTurnNextSteps(turn: {
    userMessage: string;
    reply: string;
}, llmClient: ILLMClient, suggestMode: GoalGraphSuggestMode, model?: string, onUsage?: (usage: TokenUsage) => void, bigPicture?: NextStepContext): Promise<NextStepSuggestion[]>;
