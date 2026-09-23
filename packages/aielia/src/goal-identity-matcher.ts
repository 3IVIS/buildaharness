import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'

// Phase 2 of plans/hierarchical_goal_tree_and_steering_plan.html. Resolves the plan's "Cross-turn
// identity matcher" open decision (2026-09-22): a bounded structured-LLM call, same
// callChatStructured shape as checkForContradictions (contradiction-checker.ts) — no embeddings,
// no size threshold, revisit only if a real cost/latency problem shows up benchmarked. Standalone
// utility, unused until Phase 4 wires it into the scope×urgency classifier (R4): given an incoming
// mid-task message and the set of existing GoalThreads, decide whether the message continues one
// of them (SAME_GOAL_NEW_TASK) or is unrelated to all of them (NEW_GOAL) — Phase 4's own concern,
// not this file's.

export interface GoalCandidate {
  id: string
  /** A short description of the goal's intent — e.g. a GoalThread's successCriteria/rationale — used as the identity anchor for matching, not its full task list. */
  description: string
}

export interface GoalIdentityMatchResult {
  /** The existing candidate this message's intent matches, or null when nothing matches — including on ambiguity, see `ambiguous`. Always one of `candidates`' ids, never a dangling/unrecognized one. */
  matchedGoalId: string | null
  /** True when more than one candidate plausibly matches and the model couldn't confidently pick a single one. matchedGoalId is always null in this case — never guess a specific attachment, same fail-safe direction as no-match at all. */
  ambiguous: boolean
}

const EMPTY_RESULT: GoalIdentityMatchResult = { matchedGoalId: null, ambiguous: false }

const GOAL_MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matchedGoalId: { type: ['string', 'null'] },
    ambiguous: { type: 'boolean' },
  },
  required: ['matchedGoalId', 'ambiguous'],
}

const SYSTEM_PROMPT =
  'You match an incoming user message against a list of existing goal threads to decide whether ' +
  'the message continues one of them or is about something new. You are given "message" (the ' +
  'user\'s new request) and "candidates" (existing goal threads, each an "id" and a short ' +
  '"description" of what that goal is trying to accomplish). Decide whether the message is about ' +
  'the same underlying goal as exactly one candidate — not merely a similar topic or domain, but ' +
  'the same concrete objective a reasonable person would consider "the next step of the thing I ' +
  'already asked for," not just a related idea. If exactly one candidate matches, respond with ' +
  'that candidate\'s id in "matchedGoalId". If the message is unrelated to every candidate, ' +
  'respond with "matchedGoalId": null and "ambiguous": false. If it plausibly matches more than ' +
  'one candidate and you cannot confidently pick a single one, do not guess — respond with ' +
  '"matchedGoalId": null and "ambiguous": true. Respond with JSON only: {"matchedGoalId": ' +
  'string-or-null, "ambiguous": boolean}.'

/**
 * One bounded LLM call per incoming steering message, only when there's at least one existing
 * goal thread to match against. Falls back to "no match, treat as new" — the same fail-safe
 * direction as an unrecognized/dangling id or genuine ambiguity — on any parse failure or LLM
 * error, matching this codebase's other LLM-backed classifiers (classifyTurnIntent,
 * checkForContradictions): a missed match costs nothing worse than spinning up an extra
 * `concurrent` goal root, never a wrong attachment to the wrong thread.
 */
export async function matchGoalIdentity(
  message: string,
  candidates: GoalCandidate[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<GoalIdentityMatchResult> {
  if (candidates.length === 0) return EMPTY_RESULT

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ message, candidates }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: GOAL_MATCH_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { matchedGoalId?: unknown; ambiguous?: unknown }
    const candidateIds = new Set(candidates.map((c) => c.id))
    const ambiguous = parsed.ambiguous === true
    const rawMatchedGoalId = typeof parsed.matchedGoalId === 'string' && candidateIds.has(parsed.matchedGoalId) ? parsed.matchedGoalId : null
    // Ambiguity always wins over a supplied id — a model that (incorrectly) names an id while
    // also flagging ambiguous:true must not have that id treated as a confident match.
    return { matchedGoalId: ambiguous ? null : rawMatchedGoalId, ambiguous }
  } catch {
    return EMPTY_RESULT
  }
}
