import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { looksLikeCodingFact, type BeliefCandidate } from './contradiction-checker.js'

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    conflict: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['conflict'],
}

const SYSTEM_PROMPT =
  'You check whether a proposed action genuinely conflicts with something already known to be ' +
  'true (a high-confidence belief) or predicted (an active hypothesis\'s predicted observation) ' +
  '— a real logical conflict, not just a superficially related topic (e.g. proposing to remove ' +
  'something a belief says is required, or an action that presumes the opposite of what\'s ' +
  'predicted). You are given "changeDescription", "highConfidenceBeliefs", and ' +
  '"hypothesisPredictions" as JSON. Respond with JSON only: {"conflict": boolean, "reason": ' +
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
 * slips past that phrase list entirely. Skipped when the change description itself reads like a
 * structured/technical (coding) action — see looksLikeCodingFact's doc comment for why that's
 * exactly the domain the lexical check already handles reasonably well; this is worth spending a
 * call on for a natural-language-shaped change instead. Falls back to "no conflict" on any parse
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
  if (looksLikeCodingFact(changeDescription)) return { conflict: false }

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ changeDescription, highConfidenceBeliefs, hypothesisPredictions }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: REVIEW_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { conflict?: unknown; reason?: unknown }
    if (parsed.conflict !== true) return { conflict: false }
    return { conflict: true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
  } catch {
    return { conflict: false }
  }
}
