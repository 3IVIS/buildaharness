import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { BeliefCandidate } from './contradiction-checker.js'
import { parseModelJson } from './model-json.js'

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    conflict: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['conflict'],
}

/**
 * `AUDIT_SEMANTIC_CHANGE_REVIEW` gate — feature-value audit (Phase C2 of the internal plan).
 * Default **ON**: the semantic change-reviewer LLM call ships enabled, so an unset / empty / truthy
 * value keeps today's behaviour. Set to a falsy value (`0` / `false` / `off` / `no` / `disabled`)
 * to skip the hook entirely, leaving `reviewProposedChange`'s lexical `isNegation` check as the
 * only conflict check. Read at exactly one call site — `harness-bridge.ts`, where the
 * `semanticChangeReviewer` host hook is wired. Same shape as `semanticContradictionEnabled()`
 * (contradiction-checker.ts).
 */
export function semanticChangeReviewEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_CHANGE_REVIEW ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/** Marks a steering note as coming from the change reviewer rather than from the user — agent-loop.ts gives it its own header so the proposer isn't told the user said it. */
export const REVIEW_NOTE_PREFIX = '[review] '

/** The user-facing line for a conflict the reviewer found — see AssistantTurnResult.reviewNotice. */
export function reviewNoticeText(reasons: string[]): string {
  const unique = [...new Set(reasons.map((r) => r.trim()).filter((r) => r.length > 0))]
  return `Heads up — this may conflict with something you told me earlier: ${unique.join(' ')}`
}

const SYSTEM_PROMPT =
  'You check whether a proposed action genuinely conflicts with something already known to be ' +
  'true (a high-confidence belief) or predicted (an active hypothesis\'s predicted observation) ' +
  '— a real logical conflict, not just a superficially related topic (e.g. proposing to remove ' +
  'something a belief says is required, or an action that presumes the opposite of what\'s ' +
  'predicted). A user correcting a fact they stated earlier about themselves ("actually I ' +
  'moved to Berlin") is not a conflict — the new statement supersedes the old one. You are ' +
  'given "changeDescription", "highConfidenceBeliefs", and "hypothesisPredictions" as JSON. Respond with JSON only: {"conflict": boolean, "reason": ' +
  'string}. reason only needs to be set when conflict is true.'

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
export async function checkSemanticReviewConflict(
  changeDescription: string,
  highConfidenceBeliefs: BeliefCandidate[],
  hypothesisPredictions: string[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ conflict: boolean; reason?: string }> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ changeDescription, highConfidenceBeliefs, hypothesisPredictions }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: REVIEW_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { conflict?: unknown; reason?: unknown }
    if (parsed.conflict !== true) return { conflict: false }
    return { conflict: true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
  } catch {
    return { conflict: false }
  }
}
