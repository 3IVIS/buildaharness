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
const CODING_FACT_MARKERS =
  /\b(test|tests|build|deploy(ment)?|compile|file|files|config|server|service|function|module|dependency|dependencies|error|exception|endpoint|api|database|schema|branch|commit|pipeline|ci\/cd|ci|environment|variable|package|library|repo|repository|script|command|log|status|bug|pass(ed|ing)?|fail(ed|ing)?|available|unavailable|enabled|disabled|running|stopped|online|offline|exists?|missing|present|absent)\b/i

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
