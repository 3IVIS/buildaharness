/**
 * Tolerant parsing of JSON a model was asked to return.
 *
 * A backend that can't enforce a schema (claude-cli in particular) sometimes wraps the JSON in a code
 * fence, puts a stray tag or a sentence of reasoning in front of it, or trails prose after it. A strict
 * `JSON.parse` then throws, and every classifier in this package fails open — silently losing the
 * check. This is the one place that recovers the JSON from that, so no call site needs its own copy.
 *
 * It is a strict superset of `JSON.parse`: text that already parses parses to exactly the same value,
 * and only text that would have thrown is looked at further.
 */

/** Most opening brackets tried, so a pathological reply can't make recovery quadratic. */
const MAX_CANDIDATE_STARTS = 64

const CLOSER: Record<string, string> = { '{': '}', '[': ']' }

/**
 * Parses `text` as JSON, or, failing that, the first (outermost, leftmost) JSON object/array embedded in
 * it. Throws a `SyntaxError` when there is none — the same failure a plain `JSON.parse` gives, so a
 * caller's existing `catch` keeps working.
 */
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (original) {
    const recovered = recoverJson(text)
    if (recovered.found) return recovered.value
    throw original
  }
}

function recoverJson(text: string): { found: true; value: unknown } | { found: false } {
  // A whole reply wrapped in a code fence.
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text)
  if (fenced) {
    try {
      return { found: true, value: JSON.parse(fenced[1]) }
    } catch {
      /* fall through to the scan */
    }
  }
  // Otherwise: from each opening bracket, in order, to the last matching closer. The first slice that
  // parses is the outermost object/array, so a nested one (say a single task inside a draft) is never
  // mistaken for the whole reply, and prose containing a stray "{" just fails and is skipped.
  let tried = 0
  for (let start = nextOpener(text, 0); start !== -1 && tried < MAX_CANDIDATE_STARTS; start = nextOpener(text, start + 1)) {
    tried++
    const end = text.lastIndexOf(CLOSER[text[start]])
    if (end <= start) continue
    try {
      return { found: true, value: JSON.parse(text.slice(start, end + 1)) }
    } catch {
      /* try the next opening bracket */
    }
  }
  return { found: false }
}

function nextOpener(text: string, from: number): number {
  const brace = text.indexOf('{', from)
  const bracket = text.indexOf('[', from)
  if (brace === -1) return bracket
  if (bracket === -1) return brace
  return Math.min(brace, bracket)
}
