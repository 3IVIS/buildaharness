import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { Belief } from '@buildaharness/harness'

/**
 * assistant.ts's single ad hoc/single-task turn always passes this exact sentence as its harness
 * run's successCriteria — a meta-instruction ("respond helpfully"), not a factual claim a belief
 * could ever state or paraphrase. Every other one of HarnessRuntime's semantic hooks has its own
 * cheap, no-LLM-call skip for the domain it knows doesn't need escalation (looksLikeCodingFact for
 * contradictionChecker/semanticChangeReviewer, empty symptoms/patterns for semanticFailureMatcher);
 * this is that skip for criterion coverage. Without it, any ad hoc turn with at least one recorded
 * belief would spend a real LLM call every single time, forever, on a criterion that structurally
 * can never be "covered" by a belief in the first place — found by running the existing test suite
 * against a freshly-built @buildaharness/harness dist (see this plan's Phase 5 corrections) rather
 * than by design; a durable plan's own successCriteria (real, task-specific text like "the login
 * tests pass" — see plan-store.ts's PlanRecord) is exactly the case this hook exists for and is
 * NOT skipped.
 */
export const NON_CHECKABLE_DEFAULT_CRITERION = 'Respond helpfully, accurately, and safely to the user request.'

const COVERAGE_SCHEMA = {
  type: 'object',
  properties: {
    covered: { type: 'boolean' },
  },
  required: ['covered'],
}

const SYSTEM_PROMPT =
  'You check whether a success criterion is genuinely satisfied by what a set of beliefs states — ' +
  'not by exact wording, but by meaning (a paraphrase, or any language, counts as covered if the ' +
  'meaning matches). You are given "criterion" (a single success criterion) and "beliefs" (an array ' +
  'of {id, statement} — everything currently believed true) as JSON. Respond with JSON only: ' +
  '{"covered": boolean} — true only if some belief, individually or combined with others, genuinely ' +
  'establishes the criterion is met, not just related to the same general topic.'

/**
 * One LLM call per uncovered criterion, checking it against the whole belief set at once — layered
 * on top of reviewerPass's implementerLens (packages/harness/src/nodes/reviewer-pass.ts), which
 * otherwise only checks success-criterion coverage via a plain `.includes()` substring match.
 * Called only for a criterion that substring check already found no coverage for (see
 * SemanticCriterionCoverage's own doc comment) — a criterion the cheap check already covers never
 * reaches this call. Falls back to "not covered" (the substring check's own verdict stands) on any
 * parse failure or LLM error, matching this codebase's other LLM-backed classifiers
 * (checkForContradictions, checkSemanticReviewConflict, checkSemanticFailureMatch) — a missed
 * coverage costs nothing worse than the substring-only behavior this is layered on top of, since it
 * only ever adds coverage, never removes it.
 */
export async function checkSemanticCriterionCoverage(
  criterion: string,
  beliefs: Belief[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<boolean> {
  if (beliefs.length === 0 || criterion === NON_CHECKABLE_DEFAULT_CRITERION) return false

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ criterion, beliefs: beliefs.map((b) => ({ id: b.id, statement: b.statement })) }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: COVERAGE_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { covered?: unknown }
    return parsed.covered === true
  } catch {
    return false
  }
}
