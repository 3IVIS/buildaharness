/**
 * `HARNESS_LEXICAL_OFF` — switches off the harness's own lexical checks (keyword / substring /
 * phrase-list passes) so the semantic layer sitting on top of each one runs alone.
 *
 *   HARNESS_LEXICAL_OFF=all                      every check below
 *   HARNESS_LEXICAL_OFF=negation-pairs,…         individual checks (comma list)
 *
 * Unset / empty (the default) is today's behaviour, byte-for-byte. Read at call time, never at
 * import time, with the same browser-safe `typeof process` guard the other `HARNESS_*` flags use.
 *
 * With a check off and no semantic hook wired by the host, that layer simply reports nothing —
 * nothing replaces it. The host (packages/aielia) wires the hooks and decides whether that is wanted.
 *
 *  - negation-pairs        detect-contradictions.ts — the keyword-negation pairwise detector
 *  - review-negation       review-proposed-change.ts — `isNegation` phrase/overlap check
 *  - failure-exact-match   failure-diagnostics.ts — `FailureModeLibrary.match()` substring overlap
 *                          (`getEntries()` is untouched, so a semantic matcher still sees the library)
 *  - criterion-substring   reviewer-pass.ts — the implementer lens's `.includes()` criterion coverage
 *
 * The four structural checks that merely *look* string-shaped (output-contract required sections,
 * syntax-error phrase, causal-proximity traversal) are not lexical detectors and stay on.
 */
export const HARNESS_LEXICAL_CHECKS = ['negation-pairs', 'review-negation', 'failure-exact-match', 'criterion-substring'] as const
export type HarnessLexicalCheck = (typeof HARNESS_LEXICAL_CHECKS)[number]

type EnvLike = Record<string, string | undefined>

export function resolveHarnessLexicalOff(env?: EnvLike): ReadonlySet<HarnessLexicalCheck> {
  const source: EnvLike = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.HARNESS_LEXICAL_OFF ?? '').trim().toLowerCase()
  const off = new Set<HarnessLexicalCheck>()
  if (raw === '') return off
  for (const token of raw.split(',')) {
    const name = token.trim()
    if (name === 'all') for (const c of HARNESS_LEXICAL_CHECKS) off.add(c)
    else if ((HARNESS_LEXICAL_CHECKS as readonly string[]).includes(name)) off.add(name as HarnessLexicalCheck)
  }
  return off
}

/** True unless this check is switched off. */
export function harnessLexicalActive(check: HarnessLexicalCheck, env?: EnvLike): boolean {
  const source: EnvLike = env ?? (typeof process !== 'undefined' ? process.env : {})
  if (!source.HARNESS_LEXICAL_OFF) return true // fast path: nothing set
  return !resolveHarnessLexicalOff(source).has(check)
}
