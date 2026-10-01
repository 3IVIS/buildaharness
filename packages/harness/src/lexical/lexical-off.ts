/**
 * The switch for the harness's own lexical checks (keyword / substring / token-overlap / phrase-list
 * passes over natural-language text). **Every check is OFF by default** — a semantic hook wired by the
 * host (packages/aielia) does the job instead; with no hook, the check simply never matches (e.g. no
 * contradiction is recorded, no failure pattern matches, a criterion is never found covered by a word).
 *
 *   HARNESS_LEXICAL_MODE=enabled                 every check below back on (the pre-2026-09-30 behaviour)
 *   HARNESS_LEXICAL_MODE=disabled                every check off (the default; same as unset)
 *   HARNESS_LEXICAL_ON=negation-pairs,…          turn only these on (comma list, or `all`)
 *   HARNESS_LEXICAL_OFF=negation-pairs,…         turn only these off (comma list, or `all`)
 *
 * Resolution per check: named in HARNESS_LEXICAL_OFF → off; else named in HARNESS_LEXICAL_ON → on; else
 * the mode. The mode is HARNESS_LEXICAL_MODE when set, else what the host set with
 * `setHarnessLexicalMode()` (the only way to reach this switch in a browser, where there is no
 * `process.env`), else `disabled`. Read at call time, never at import time.
 *
 *  - negation-pairs          detect-contradictions.ts — the keyword-negation matcher, both the pairwise
 *                            detector and the set-level (triple) detector built on it
 *  - granularity-markers     update-diagnostics.ts's world-model granularity estimate and
 *                            detect-contradictions.ts's abstraction contradictions (keyword lists)
 *  - review-negation         review-proposed-change.ts — `isNegation` phrase/overlap check
 *  - review-phrases          review-proposed-change.ts — the "remove <section>" and "syntax error" phrases
 *  - failure-exact-match     failure-diagnostics.ts — `FailureModeLibrary.match()` substring overlap
 *                            (`getEntries()` is untouched, so a semantic matcher still sees the library)
 *  - system-error-symptoms   execute.ts — errno / HTTP-status phrases mapped onto library symptom text
 *  - criterion-substring     reviewer-pass.ts — the implementer lens's `.includes()` criterion coverage
 *  - criterion-proximity     reviewer-pass.ts — the adversarial seed's "belief text contains a criterion"
 *  - criterion-scope         check-caller-updates.ts / caller-state.ts — token overlap between criteria and
 *                            tasks (scope elimination, coverage) or beliefs (stale flags)
 *  - constraint-negation     output-validation.ts — the lexical caller-constraint check
 *  - preference-patterns     primitives/preference-extractor.ts — phrase lists for feedback preferences
 *  - source-dedupe           primitives/multi-source-reducer.ts — word-overlap near-duplicate detection
 *
 * Not covered, on purpose: output-contract.ts's `required:` DSL parse (flow-author syntax, not free text)
 * and output-validation.ts's required_sections / validation_rules (object-key presence, not text).
 */
export const HARNESS_LEXICAL_CHECKS = [
  'negation-pairs',
  'granularity-markers',
  'review-negation',
  'review-phrases',
  'failure-exact-match',
  'system-error-symptoms',
  'criterion-substring',
  'criterion-proximity',
  'criterion-scope',
  'constraint-negation',
  'preference-patterns',
  'source-dedupe',
] as const
export type HarnessLexicalCheck = (typeof HARNESS_LEXICAL_CHECKS)[number]

export type HarnessLexicalMode = 'enabled' | 'disabled'
export const DEFAULT_HARNESS_LEXICAL_MODE: HarnessLexicalMode = 'disabled'

type EnvLike = Record<string, string | undefined>

let hostMode: HarnessLexicalMode | undefined

/**
 * Lets a host set the mode where there is no `process.env` (a browser tab, the desktop webview), or
 * without mutating it. `undefined` clears it. An explicit HARNESS_LEXICAL_MODE still wins.
 */
export function setHarnessLexicalMode(mode: HarnessLexicalMode | undefined): void {
  hostMode = mode
}

function envSource(env?: EnvLike): EnvLike {
  return env ?? (typeof process !== 'undefined' && process.env ? process.env : {})
}

function parseList(raw: string | undefined): Set<HarnessLexicalCheck> {
  const out = new Set<HarnessLexicalCheck>()
  for (const token of String(raw ?? '').toLowerCase().split(',')) {
    const name = token.trim()
    if (name === 'all') for (const c of HARNESS_LEXICAL_CHECKS) out.add(c)
    else if ((HARNESS_LEXICAL_CHECKS as readonly string[]).includes(name)) out.add(name as HarnessLexicalCheck)
  }
  return out
}

export function resolveHarnessLexicalMode(env?: EnvLike): HarnessLexicalMode {
  const raw = String(envSource(env).HARNESS_LEXICAL_MODE ?? '').trim().toLowerCase()
  if (raw === 'enabled' || raw === 'disabled') return raw
  return hostMode ?? DEFAULT_HARNESS_LEXICAL_MODE
}

/** Every check currently switched off. */
export function resolveHarnessLexicalOff(env?: EnvLike): ReadonlySet<HarnessLexicalCheck> {
  const source = envSource(env)
  const off = parseList(source.HARNESS_LEXICAL_OFF)
  const on = parseList(source.HARNESS_LEXICAL_ON)
  const modeOn = resolveHarnessLexicalMode(source) === 'enabled'
  for (const c of HARNESS_LEXICAL_CHECKS) if (!modeOn && !on.has(c)) off.add(c)
  return off
}

/** True only if this check is switched on. */
export function harnessLexicalActive(check: HarnessLexicalCheck, env?: EnvLike): boolean {
  return !resolveHarnessLexicalOff(env).has(check)
}
