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
/**
 * Parses `text` as JSON, or, failing that, the first (outermost, leftmost) JSON object/array embedded in
 * it. Throws a `SyntaxError` when there is none — the same failure a plain `JSON.parse` gives, so a
 * caller's existing `catch` keeps working.
 */
export declare function parseModelJson(text: string): unknown;
