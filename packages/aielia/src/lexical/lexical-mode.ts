/**
 * `lexicalMode` — one switch that turns off the assistant's *lexical checks* (regex / marker /
 * phrase-list passes) so a semantic (LLM) layer runs on its own, with nothing lexical able to
 * explain its outcome.
 *
 *  - `ASSISTANT_LEXICAL_MODE=disabled` switches off the CHECK families below — the lexical passes a
 *    semantic layer is layered on top of. Unset / `enabled` (the default) is today's behaviour,
 *    byte-for-byte.
 *  - `ASSISTANT_LEXICAL_OFF=<family>[,<family>…]` switches off any family individually, including
 *    the routers and the safety floor, which `disabled` deliberately leaves on.
 *
 * What "off" means differs by kind, so the families are not interchangeable:
 *  - fact-markers    the lexical fact pass produces no `user_asserted` facts; only the LLM
 *                    `statesDurableFacts` path forms beliefs.
 *  - coding-fact     `looksLikeCodingFact` is false, so the "skip the LLM, the lexical check covers
 *                    it" gates never skip: every semantic hook it guards runs.
 *  - injection       the regex pass never flags, and the "too short to bother the LLM" length gate is
 *                    dropped so the LLM sees every tool output.
 *  - enumeration     `looksLikeEnumeratedItems` is false (the decomposition heuristic only).
 *
 * Stay on under `disabled` (they are routers or a safety floor, not checks under a semantic layer):
 *  - risk            `classifyRisk`'s lexical high-risk / bulk-reminder gate — the fallback when the
 *                    LLM classifier fails. The bulk-reminder gate keeps its own un-gated enumeration
 *                    check for the same reason.
 *  - task-cancel, plan-mode, batch-list, tool-yield, template-keywords
 *
 * The MCP file server's injection regex also stays on: under the claude-cli backend it is the only
 * injection check fetched pages get, because the LLM check never sees those results.
 *
 * Read at call time, never at import time (several modules compile their patterns at import), and
 * with the same browser-safe `typeof process` guard the `AUDIT_*` flags use.
 */

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

/** The families `lexicalMode: 'disabled'` switches off: lexical checks that sit under a semantic layer. */
export const LEXICAL_CHECK_FAMILIES: readonly LexicalFamily[] = ['fact-markers', 'coding-fact', 'injection', 'enumeration']

export type LexicalMode = 'enabled' | 'disabled'

export const DEFAULT_LEXICAL_MODE: LexicalMode = 'disabled'

type EnvLike = Record<string, string | undefined>

function envSource(env?: EnvLike): EnvLike {
  return env ?? (typeof process !== 'undefined' ? process.env : {})
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

/** Every family currently switched off, from the mode and the per-family list. */
export function resolveLexicalOff(env?: EnvLike): ReadonlySet<LexicalFamily> {
  const off = new Set<LexicalFamily>()
  if (resolveLexicalMode(env) === 'disabled') for (const f of LEXICAL_CHECK_FAMILIES) off.add(f)
  const list = String(envSource(env).ASSISTANT_LEXICAL_OFF ?? '')
  for (const token of list.split(',')) {
    const name = token.trim().toLowerCase()
    if (name === '') continue
    if (isLexicalFamily(name)) off.add(name)
    else warnOnce(`ASSISTANT_LEXICAL_OFF names unknown family "${name}" — ignored (known: ${LEXICAL_FAMILIES.join(', ')}).`)
  }
  return off
}

/** True unless this family is switched off. Cheap enough to call on every check. */
export function lexicalActive(family: LexicalFamily, env?: EnvLike): boolean {
  const source = envSource(env)
  // Fast path, nothing set: falls through to the real default rather than hardcoding "active" —
  // that hardcoding was only ever correct while DEFAULT_LEXICAL_MODE was 'enabled' (nothing off).
  // Still cheap: no resolveLexicalOff() allocation for a family the mode default doesn't touch.
  if (!source.ASSISTANT_LEXICAL_MODE && !source.ASSISTANT_LEXICAL_OFF) {
    return DEFAULT_LEXICAL_MODE === 'enabled' || !(LEXICAL_CHECK_FAMILIES as readonly string[]).includes(family)
  }
  return !resolveLexicalOff(source).has(family)
}

/** The off families as a comma list, for handing to an out-of-process helper (the MCP server). */
export function lexicalOffEnvValue(env?: EnvLike): string {
  return [...resolveLexicalOff(env)].join(',')
}

let harnessFlagSetBySync = false

/**
 * Makes `lexicalMode: 'disabled'` cover the harness package's own lexical checks too: sets
 * `HARNESS_LEXICAL_OFF=all` (packages/harness/src/lexical/lexical-off.ts) for the duration of the
 * mode, and clears it again once the mode is back to enabled. Never overrides a value the operator set
 * explicitly, and only ever clears a value this function set — so it cannot leak from one run (or
 * one eval arm) into the next. Called at the start of every harness run; a no-op outside Node.
 */
export function syncHarnessLexicalEnv(env?: EnvLike): void {
  if (env === undefined && typeof process === 'undefined') return
  const target = (env ?? process.env) as Record<string, string | undefined>
  const disabled = resolveLexicalMode(target) === 'disabled'
  if (disabled && !target.HARNESS_LEXICAL_OFF) {
    target.HARNESS_LEXICAL_OFF = 'all'
    harnessFlagSetBySync = true
  } else if (!disabled && harnessFlagSetBySync) {
    delete target.HARNESS_LEXICAL_OFF
    harnessFlagSetBySync = false
  }
}
