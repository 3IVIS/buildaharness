import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { ExternalContradictionInput } from '@buildaharness/harness'

export interface BeliefCandidate {
  id: string
  statement: string
}

// The lexical/negation-pair check (detect-contradictions.ts, always-on and free) already
// covers boolean/system-state-shaped claims well — build passed/failed, file exists/missing,
// service available/unavailable, and so on. If every newly-added belief looks like that kind
// of structured, technical claim, there's nothing this LLM call would catch that the lexical
// pass hasn't already had a fair shot at — so it's skipped entirely, no LLM call spent.
// "passed"/"passing" alone also matches the entirely unrelated "passed away" (died) idiom —
// found via live testing: "Actually, Biscuit passed away last month — I adopted a new cat named
// Pepper instead." got admitted as a fact purely because of this coincidental collision (the
// original "I have a cat named Biscuit" statement itself was never captured, since nothing else
// here or in fact-extraction.ts's other markers matches an ordinary pet-ownership statement) —
// producing a confusing, out-of-context fact entry ("Biscuit passed away...") with no record of
// what it was correcting. "passed"/"passing" immediately followed by "away" is never the
// build/test-status sense this list exists for, so it's excluded rather than admitted.
// batch 10 re-probe (conv166/h12, investigated as staged): "package" only matched the singular
// form — \bpackage\b's trailing word boundary can't match a directly-appended plural "s", so
// "...tracking packages..." never looksLikeCodingFact, extractFactsFromTurn's isClaimClause gate
// fails, and the whole statement is dropped before it ever becomes a belief at all — no
// contradiction check (lexical or LLM) ever gets a chance to run, since there's no second belief
// to compare against. Found via live testing: "I never bother insuring or tracking packages,
// it's not worth the hassle." (a genuine contradiction with an earlier "I always insure and track
// any package I mail." statement) was silently dropped entirely, while the singular-form version
// of the same statement was correctly captured and flagged as contradictory. Several other nouns
// in this list have the same singular-only gap (library, script, command, log, bug, commit,
// error, exception, server, service, function, database, config, module, variable, schema,
// endpoint) — left as a known adjacent gap for a future pass rather than widening all of them
// speculatively without live-testing each one.
// batch 12 re-probe (conv178/conv198): "repo" and "branch" are two of those named sibling gaps,
// now live-tested — "I never bother backing up my repos anymore" and "I never bother squashing or
// rebasing branches anymore" both reproduced the exact same drop, each contradicting an earlier
// singular-form statement ("...my repo...", "...any branch...") that had been captured fine.
// Widened just these two (not the rest of the still-untested list above) for the same reason the
// package fix stayed narrow: confirm each one live rather than widening speculatively.
const CODING_FACT_MARKERS =
  /\b(test|tests|build|deploy(ment)?|compile|file|files|config|server|service|function|module|dependency|dependencies|error|exception|endpoint|api|database|schema|branch(?:es)?|commit|pipeline|ci\/cd|ci|environment|variable|packages?|library|repos?|repository|script|command|log|status|bug|pass(?:ed|ing)?(?!\s+away)|fail(ed|ing)?|available|unavailable|enabled|disabled|running|stopped|online|offline|exists?|missing|present|absent)\b/i

// This substring match, and the shared-subject gate in detect-contradictions.ts's
// statementsOpposed (packages/harness), only catch a real contradiction when the two compared
// statements lead with the same concrete subject ("the login tests" vs "the login tests", not
// "the login tests" vs "the auth suite") — which is why decomposition-classifier.ts and
// plan-builder.ts prompt task descriptions to be phrased subject-first.
/** Zero-LLM-call gate: true when a belief statement reads like a structured/technical (build, test, service, file) claim rather than a natural-language personal fact. */
export function looksLikeCodingFact(statement: string): boolean {
  return CODING_FACT_MARKERS.test(statement)
}

// Phase 2 (layer 1, World Model) writes a synthetic "Completed: <task description>" belief as
// an auditable trail for a multi-step/consequential turn with no extracted fact — a bookkeeping
// record of what ran, not a first-order claim about the world. Two task-completion records
// ("Completed: X", "Completed: Y") are never meaningfully "contradictory" the way two competing
// facts are, so there's nothing here worth an LLM call over, no matter how the phrasing reads.
const TASK_COMPLETION_TRAIL_PREFIX = /^Completed: /

function isCheckWorthy(statement: string): boolean {
  return !looksLikeCodingFact(statement) && !TASK_COMPLETION_TRAIL_PREFIX.test(statement)
}

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beliefIds: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
        required: ['beliefIds', 'description'],
      },
    },
  },
  required: ['contradictions'],
}

const SYSTEM_PROMPT =
  'You check a personal assistant\'s beliefs for genuine contradictions — statements that cannot ' +
  "both be true at the same time (e.g. two different home cities, conflicting preferences, " +
  'opposite factual claims). Do not flag beliefs that are merely about different topics, or that ' +
  'could both be true (e.g. "likes coffee" and "likes tea" are not a contradiction). You are given ' +
  '"newBeliefs" (just learned) and "existingBeliefs" (already known and already mutually ' +
  'consistent with each other) as JSON. Check newBeliefs against existingBeliefs, and against each ' +
  'other. Respond with JSON only: {"contradictions": [{"beliefIds": [id, id, ...], "description": ' +
  'string}]}. Empty array if none.'

/**
 * One LLM call reviewing whatever belief(s) were just added against everything already known —
 * never per-pair, never a full re-scan (old-vs-old was already cleared by a previous call).
 * Skips the LLM call entirely when every new belief looks like a structured/technical claim the
 * always-on lexical check already handles (see looksLikeCodingFact). Falls back to "no
 * contradictions found" on any parse failure or LLM error, matching this codebase's other
 * LLM-backed classifiers (isAbandonPhraseWithLLM, classifyRiskWithLLM) — a missed contradiction
 * costs nothing worse than the lexical-only behavior this is layered on top of.
 */
export async function checkForContradictions(
  newBeliefs: BeliefCandidate[],
  existingBeliefs: BeliefCandidate[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<ExternalContradictionInput[]> {
  if (newBeliefs.length === 0) return []
  if (newBeliefs.every((b) => !isCheckWorthy(b.statement))) return []

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ newBeliefs, existingBeliefs }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: CONTRADICTION_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { contradictions?: ExternalContradictionInput[] }
    return Array.isArray(parsed.contradictions) ? parsed.contradictions : []
  } catch {
    return []
  }
}
