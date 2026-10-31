import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
export interface GoalCandidate {
    id: string;
    /** A short description of the goal's intent — e.g. a GoalThread's successCriteria/rationale — used as the identity anchor for matching, not its full task list. */
    description: string;
}
export interface GoalIdentityMatchResult {
    /** The existing candidate this message's intent matches, or null when nothing matches — including on ambiguity, see `ambiguous`. Always one of `candidates`' ids, never a dangling/unrecognized one. */
    matchedGoalId: string | null;
    /** True when more than one candidate plausibly matches and the model couldn't confidently pick a single one. matchedGoalId is always null in this case — never guess a specific attachment, same fail-safe direction as no-match at all. */
    ambiguous: boolean;
}
/**
 * One bounded LLM call per incoming steering message, only when there's at least one existing
 * goal thread to match against. Falls back to "no match, treat as new" — the same fail-safe
 * direction as an unrecognized/dangling id or genuine ambiguity — on any parse failure or LLM
 * error, matching this codebase's other LLM-backed classifiers (classifyTurnIntent,
 * checkForContradictions): a missed match costs nothing worse than spinning up an extra
 * `concurrent` goal root, never a wrong attachment to the wrong thread.
 */
export declare function matchGoalIdentity(message: string, candidates: GoalCandidate[], llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<GoalIdentityMatchResult>;
