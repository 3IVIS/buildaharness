import { looksLikeCodingFact } from './contradiction-checker.js'

export interface UserFact {
  text: string
  extractedAt: string
  sourceTurn: string
  /**
   * True for a fact durable/safety-relevant enough to survive /new (name, stated preference,
   * health/dietary — see DURABLE_MARKERS below), false for a session-scoped detail (current
   * location, current job, "remember that"-style context) that's expected to change more often
   * and isn't the kind of thing that should silently reappear in a conversation the user
   * explicitly started fresh. assistant.ts's recordFacts() stores durable facts in a second,
   * never-cleared store in addition to the per-session one.
   */
  durable: boolean
}

// Cheap, zero-LLM-call gate — only messages that look like the user is stating
// something durable about themselves are captured. Deliberately dumb (verbatim
// capture of the whole message, no dedup/merge) — see transcript-compaction.ts's
// sibling tradeoff note in the personal-assistant README for why this stays
// free rather than spending a second LLM call per turn. Exported: reminder-tools.ts
// reuses this exact gate to refuse create_reminder for the same fact-shaped text,
// so a durable fact (an allergy, a preference, ...) can't end up filed as a to-do
// item in the reminders store — see that module's doc comment for why relying on
// the create_reminder tool description alone wasn't reliable enough on its own.
export const FACT_MARKERS = /\b(my name is|i live in|i work (at|as|for)|i am a|i'm a|i prefer|remember that|for future reference|call me)\b/i

// Health/dietary self-statements ("I'm allergic to shellfish") are exactly the kind of durable,
// safety-relevant fact this store exists for, but never matched FACT_MARKERS' identity-statement
// phrasing ("my name is", "i'm a", ...) — same gap looksLikeCodingFact was added to close for
// build/test/service-state claims. Kept separate from FACT_MARKERS (rather than folded in)
// since it's a different semantic category with its own phrasing shape. The optional "not "/"no
// longer " lets a correction to a previously-stated fact ("I'm not vegetarian anymore", "I'm no
// longer allergic to shellfish") still match — the corrected state is itself exactly the kind of
// durable fact this store exists to capture, and without it the negation broke adjacency to the
// marker word and the whole regex silently failed to match, dropping the correction entirely.
// Exported so reminder-tools.ts and file-tools-mcp-server.mjs (the claude-cli backend's separate
// tool implementation, kept in sync by hand) can both refuse create_reminder for the same
// fact-shaped text this module captures as a UserFact — mirroring how FACT_MARKERS is already
// shared for that purpose.
export const HEALTH_OR_DIETARY_MARKERS =
  /\b(i'?m|i am) (not |no longer )?(allergic to|diabetic|vegetarian|vegan|lactose intolerant|gluten[\s-]free)\b|\bi('?ve| have) (an? .{0,20})?allerg\w*\b|\b(i don'?t eat|i can'?t eat|i cannot eat)\b/i

// The subset of FACT_MARKERS worth surviving /new: a name or a stated preference is durable and
// safety/identity-relevant the same way a health/dietary fact is, unlike a current location or
// current job (expected to change more often) or the generic "remember that"/"for future
// reference" phrasing (context-dependent — could be about anything transient). Deliberately a
// narrow subset, not all of FACT_MARKERS, so /new keeps clearing everything that isn't clearly
// meant to persist.
const DURABLE_NAME_OR_PREFERENCE_MARKERS = /\b(my name is|call me|i prefer)\b/i

function isDurable(text: string): boolean {
  return DURABLE_NAME_OR_PREFERENCE_MARKERS.test(text) || HEALTH_OR_DIETARY_MARKERS.test(text)
}

// looksLikeCodingFact is a pure keyword match, so "please delete the old backup files" and
// "what does missing.txt say?" admit just as readily as "the tests passed" — the first is a
// request, the second a question; merely mentioning "files"/"missing" doesn't make either a
// claim about the world. Excluding request and question phrasing keeps admission scoped to
// actual state claims; FACT_MARKERS' phrases ("my name is", "remember that", ...) are already
// declarative by construction and don't need this filter.
const NON_CLAIM_MARKERS = /\?\s*$|^(what|when|where|why|who|which|how)\b|\b(please|can you|could you|would you|will you|help me|delete|remove|run|execute|install|deploy|restart|stop|start|create|write|update|set up|change|fix|add|revert|undo)\b/i

// NON_CLAIM_MARKERS is meant to reject a clause that IS a request/question, not to reject any
// message that merely contains a request-shaped clause anywhere — but scanning the whole
// message let an unrelated trailing clause's "please"/"can you" suppress a genuine fact-bearing
// clause elsewhere in the same sentence ("I'm diabetic, so please remind me to check sugar
// content" lost the diabetic fact entirely, because "please" appears later in the sentence).
// Splitting on clause boundaries (sentence punctuation, or a comma before a coordinating
// conjunction) and checking NON_CLAIM_MARKERS per clause keeps the request clause's words from
// reaching across into a separate, independent claim clause.
const CLAUSE_BOUNDARY = /[.!?;]+|,\s*(?:so|but|and|because|although|while|whereas)\b/i

function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

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
  const admit = (): UserFact[] => [{ text: trimmed, extractedAt: new Date().toISOString(), sourceTurn, durable: isDurable(trimmed) }]
  // FACT_MARKERS' phrases are declarative by construction (unaffected by NON_CLAIM_MARKERS, as
  // before this change) and matched against the whole message, not per clause.
  if (FACT_MARKERS.test(trimmed)) return admit()
  const isClaimClause = splitClauses(trimmed).some(
    (clause) => (looksLikeCodingFact(clause) || HEALTH_OR_DIETARY_MARKERS.test(clause)) && !NON_CLAIM_MARKERS.test(clause),
  )
  return isClaimClause ? admit() : []
}
