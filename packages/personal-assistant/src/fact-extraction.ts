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

/** Extracts at most one durable fact from a user message — verbatim, not summarized. Returns [] when the message doesn't look like a fact statement. */
export function extractFactsFromTurn(userMessage: string, sourceTurn: string): UserFact[] {
  const trimmed = userMessage.trim()
  if (!FACT_MARKERS.test(trimmed)) return []
  return [{ text: trimmed, extractedAt: new Date().toISOString(), sourceTurn }]
}
