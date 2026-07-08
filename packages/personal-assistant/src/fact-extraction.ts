import { looksLikeCodingFact } from './contradiction-checker.js'

export interface UserFact {
  text: string
  extractedAt: string
  sourceTurn: string
}

// Cheap, zero-LLM-call gate — only messages that look like the user is stating
// something durable about themselves are captured. Deliberately dumb (verbatim
// capture of the whole message, no dedup/merge) — see transcript-compaction.ts's
// sibling tradeoff note in the personal-assistant README for why this stays
// free rather than spending a second LLM call per turn.
const FACT_MARKERS = /\b(my name is|i live in|i work (at|as|for)|i am a|i'm a|i prefer|remember that|for future reference|call me)\b/i

// looksLikeCodingFact is a pure keyword match, so "please delete the old backup files" and
// "what does missing.txt say?" admit just as readily as "the tests passed" — the first is a
// request, the second a question; merely mentioning "files"/"missing" doesn't make either a
// claim about the world. Excluding request and question phrasing keeps admission scoped to
// actual state claims; FACT_MARKERS' phrases ("my name is", "remember that", ...) are already
// declarative by construction and don't need this filter.
const NON_CLAIM_MARKERS = /\?\s*$|^(what|when|where|why|who|which|how)\b|\b(please|can you|could you|would you|will you|help me|delete|remove|run|execute|install|deploy|restart|stop|start|create|write|update|set up|change|fix|add|revert|undo)\b/i

/**
 * Extracts at most one durable fact from a user message — verbatim, not summarized. Returns []
 * when the message doesn't look like a fact statement.
 *
 * Also admits anything looksLikeCodingFact (contradiction-checker.ts) recognizes, unless the
 * message also reads as a request or a question rather than a claim — a build/test/service-state
 * claim like "the tests passed" is exactly what the World Model's belief/contradiction machinery
 * (CODING_FACT_MARKERS, NEGATION_PAIRS) is built to track, but FACT_MARKERS' personal-fact
 * phrasing never matched statements like that, so no belief was ever created for the
 * contradiction checks to compare — a "tests passed" / "tests failed" flip produced zero beliefs
 * and thus zero contradiction detection at any layer, lexical or LLM.
 */
export function extractFactsFromTurn(userMessage: string, sourceTurn: string): UserFact[] {
  const trimmed = userMessage.trim()
  const isCodingFact = looksLikeCodingFact(trimmed) && !NON_CLAIM_MARKERS.test(trimmed)
  if (!FACT_MARKERS.test(trimmed) && !isCodingFact) return []
  return [{ text: trimmed, extractedAt: new Date().toISOString(), sourceTurn }]
}
