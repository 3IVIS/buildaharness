/**
 * Script-aware text utilities shared by every lexical (non-LLM) check in this monorepo — the one
 * place CJK-vs-Latin handling lives, so a check's own regex/keyword logic doesn't need its own
 * tokenization strategy. Mirrored in adapter/harness/script_utils.py for Python's own harness
 * implementation; packages/personal-assistant imports this module (via @buildaharness/harness,
 * already a real dependency) rather than reimplementing it — personal-assistant is one
 * application built on buildaharness, not a place for harness-core infrastructure to live.
 *
 * `.split(/\s+/)`-based word counting/tokenization silently breaks on CJK text, which has no
 * inter-word whitespace — an entire Chinese sentence splits into exactly one "word". These
 * utilities give every consumer a tokenization that's meaningful for both: CJK spans are split
 * per-character (a cheap, no-dependency approximation of real segmentation — weaker precision
 * than a real segmenter, but every consumer already treats its own lexical check as a fast
 * pre-filter with the real judgment call handled elsewhere), non-CJK spans keep ordinary
 * whitespace-based word splitting.
 */

// CJK Unified Ideographs, Extension A, and Compatibility Ideographs — covers the vast majority of
// real-world Chinese/Japanese-kanji text without pulling in a full Unicode script database.
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/
// Unambiguous CJK clause/sentence boundaries (period, exclamation, question mark, semicolon —
// both fullwidth and halfwidth forms). Deliberately excludes the CJK comma (，) and enumeration
// comma (、): those are closer to an English comma and need the same conjunction-word
// disambiguation English commas already get elsewhere, not a blanket split.
const CJK_CLAUSE_PUNCTUATION = /[。！？；!?;]/g

export function containsCJK(text: string): boolean {
  return CJK_CHAR.test(text)
}

/**
 * Splits `text` into tokens: each CJK character becomes its own token, everything else is
 * whitespace-split as usual. For text with no CJK characters at all, this is byte-for-byte
 * equivalent to `text.split(/\s+/).filter(Boolean)` — the existing behavior every consumer being
 * migrated onto this module already relies on.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      if (buffer) {
        tokens.push(...buffer.split(/\s+/).filter(Boolean))
        buffer = ''
      }
      tokens.push(ch)
    } else {
      buffer += ch
    }
  }
  if (buffer) tokens.push(...buffer.split(/\s+/).filter(Boolean))
  return tokens
}

/** Token count — keeps `WORD_LIMIT`-style length thresholds meaningful once CJK content exists. */
export function tokenCount(text: string): number {
  return tokenize(text).length
}

/**
 * Case-insensitive shared-token overlap between two strings, minus `stopwords` — the "do these
 * two statements share a subject" gate several lexical checks use before treating any other
 * signal (a negation pair, a trigger word) as meaningful. Filtering stopwords from each side
 * before intersecting (rather than filtering the intersection afterward) is mathematically
 * equivalent, since a stopword excluded from either side can never survive an intersection anyway.
 */
export function sharedTokens(a: string, b: string, stopwords: ReadonlySet<string> = new Set()): string[] {
  const setA = new Set(tokenize(a).map((t) => t.toLowerCase()).filter((t) => !stopwords.has(t)))
  const setB = new Set(tokenize(b).map((t) => t.toLowerCase()).filter((t) => !stopwords.has(t)))
  return [...setA].filter((t) => setB.has(t))
}

/**
 * Splits `text` into clauses on CJK sentence-ending punctuation and, additionally, on
 * `extraBoundary` if supplied — a caller's own English conjunction-word/punctuation boundary
 * (e.g. fact-extraction.ts's `CLAUSE_BOUNDARY`, risk-classifier.ts's `RISK_CLAUSE_BOUNDARY`),
 * applied within each CJK-punctuation-delimited chunk. For text with no CJK punctuation, this
 * reduces to exactly `text.split(extraBoundary)`.
 */
export function splitClauses(text: string, extraBoundary?: RegExp): string[] {
  const chunks = text.split(CJK_CLAUSE_PUNCTUATION)
  const result: string[] = []
  for (const chunk of chunks) {
    if (extraBoundary) result.push(...chunk.split(extraBoundary))
    else result.push(chunk)
  }
  return result.map((s) => s.trim()).filter(Boolean)
}
