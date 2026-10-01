/**
 * `lexicalMode` — the switch for every one of the assistant's *lexical* passes (regex / marker /
 * phrase-list / keyword checks over natural-language text). **Every family is OFF by default**, in
 * every front end (CLI, browser tab, desktop app).
 *
 *  - `ASSISTANT_LEXICAL_MODE=enabled` turns every family back on (the pre-2026-09-28 behaviour);
 *    `disabled`, or unset, is the default: every family off.
 *  - `ASSISTANT_LEXICAL_ON=<family>[,<family>…]` turns only those back on (`all` for every family).
 *  - `ASSISTANT_LEXICAL_OFF=<family>[,<family>…]` turns those off even under `enabled`; it wins over ON.
 *
 * What "off" means per family (with no semantic replacement, the step simply does nothing):
 *  - fact-markers       the lexical fact pass produces no `user_asserted` facts (only the LLM
 *                       `statesDurableFacts` path forms beliefs); the reminder tools no longer refuse a
 *                       reminder for looking like a stated fact.
 *  - coding-fact        `looksLikeCodingFact` is false, so the "skip the LLM" gates never skip.
 *  - injection          the regex pass never flags (in the MCP file server too), and the "too short to
 *                       bother the LLM" length gate is dropped, so the LLM check sees every tool output.
 *  - enumeration        `looksLikeEnumeratedItems` is false (the decomposition heuristic).
 *  - risk               `classifyRisk` makes no judgment; a durable plan step persisted without its own
 *                       risk level is treated as HIGH, the same way an UNKNOWN risk is.
 *  - task-cancel        "skip that step" is not matched deterministically; the turn is classified as usual.
 *  - plan-mode          "cancel the planning" is not matched by phrase while drafting (`/plan` still works).
 *  - batch-list         no message is read as a homogeneous lookup list, so batch research never starts.
 *  - tool-yield         a batch sub-loop result is a dead end only on the tool's own no-results literal.
 *  - template-keywords  plan templates are chosen by the classifier only; the keyword scorer is inert.
 *
 * Read at call time, never at import time, with the same browser-safe `typeof process` guard the
 * `AUDIT_*` flags use. The harness's own lexical checks have their own switch
 * (`@buildaharness/harness`'s HARNESS_LEXICAL_*); `syncHarnessLexicalEnv` hands this mode to it.
 */
import { setHarnessLexicalMode } from '@buildaharness/harness'

export const LEXICAL_FAMILIES = [
  'fact-markers',
  'coding-fact',
  'injection',
  'enumeration',
  'risk',
  'task-cancel',
  'plan-mode',
  'batch-list',
  'tool-yield',
  'template-keywords',
] as const

export type LexicalFamily = (typeof LEXICAL_FAMILIES)[number]

/** The families `lexicalMode: 'disabled'` (the default) switches off: all of them. */
export const LEXICAL_CHECK_FAMILIES: readonly LexicalFamily[] = LEXICAL_FAMILIES

export type LexicalMode = 'enabled' | 'disabled'

export const DEFAULT_LEXICAL_MODE: LexicalMode = 'disabled'

type EnvLike = Record<string, string | undefined>

function envSource(env?: EnvLike): EnvLike {
  return env ?? (typeof process !== 'undefined' && process.env ? process.env : {})
}

export function isLexicalFamily(v: string): v is LexicalFamily {
  return (LEXICAL_FAMILIES as readonly string[]).includes(v)
}

const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.error(`[warning] ${message}`)
}

/** Unset/empty ⇒ default silently; an unrecognized value ⇒ default with a warning. */
export function resolveLexicalMode(env?: EnvLike): LexicalMode {
  const raw = String(envSource(env).ASSISTANT_LEXICAL_MODE ?? '').trim().toLowerCase()
  if (raw === '') return DEFAULT_LEXICAL_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  warnOnce(`ASSISTANT_LEXICAL_MODE="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_LEXICAL_MODE}).`)
  return DEFAULT_LEXICAL_MODE
}

function parseFamilies(varName: string, raw: string | undefined): Set<LexicalFamily> {
  const out = new Set<LexicalFamily>()
  for (const token of String(raw ?? '').split(',')) {
    const name = token.trim().toLowerCase()
    if (name === '') continue
    if (name === 'all') for (const f of LEXICAL_FAMILIES) out.add(f)
    else if (isLexicalFamily(name)) out.add(name)
    else warnOnce(`${varName} names unknown family "${name}" — ignored (known: ${LEXICAL_FAMILIES.join(', ')}).`)
  }
  return out
}

/** Every family currently switched off: named in OFF, or not named in ON while the mode is disabled. */
export function resolveLexicalOff(env?: EnvLike): ReadonlySet<LexicalFamily> {
  const source = envSource(env)
  const off = parseFamilies('ASSISTANT_LEXICAL_OFF', source.ASSISTANT_LEXICAL_OFF)
  const on = parseFamilies('ASSISTANT_LEXICAL_ON', source.ASSISTANT_LEXICAL_ON)
  if (resolveLexicalMode(source) === 'disabled') for (const f of LEXICAL_FAMILIES) if (!on.has(f)) off.add(f)
  return off
}

/** True only if this family is switched on. */
export function lexicalActive(family: LexicalFamily, env?: EnvLike): boolean {
  return !resolveLexicalOff(env).has(family)
}

/**
 * The off families as a comma list, for handing to an out-of-process helper (the MCP server). Always
 * pass it, even empty: the helper reads an unset variable as "every family off" (the default) and an
 * empty one as "none off".
 */
export function lexicalOffEnvValue(env?: EnvLike): string {
  return [...resolveLexicalOff(env)].join(',')
}

/**
 * Hands this mode to the harness package's own lexical switch (`setHarnessLexicalMode`), so
 * `ASSISTANT_LEXICAL_MODE=enabled` turns the harness's checks back on too. Works in a browser as well
 * as in Node (it sets no environment variable), and an explicit HARNESS_LEXICAL_MODE /
 * HARNESS_LEXICAL_ON / HARNESS_LEXICAL_OFF still wins inside the harness. Called at the start of every
 * harness run.
 */
export function syncHarnessLexicalEnv(env?: EnvLike): void {
  setHarnessLexicalMode(resolveLexicalMode(env))
}
