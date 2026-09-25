/**
 * Flag for the AL3a ambiguity guard — same shape as ask-mode-flag.ts (module-level default, value-level
 * normalizer that warns on a typo, env resolver). 'disabled' (the default, AL-8) keeps every turn on the
 * pre-AL3a routing byte-for-byte: an under-specified consequential request still reaches `needs_approval`
 * with a guessed action. 'enabled' runs one bounded scope check (ambiguity-guard.ts) on consequential
 * turns and answers with a clarifying question *before* anything is staged when the request does not
 * determine the action.
 */
export type AmbiguityGuardMode = 'enabled' | 'disabled'

export const DEFAULT_AMBIGUITY_GUARD_MODE: AmbiguityGuardMode = 'disabled'

export function normalizeAmbiguityGuardMode(raw: string | undefined, varName = 'ASSISTANT_AMBIGUITY_GUARD'): AmbiguityGuardMode {
  if (raw === undefined || raw === '') return DEFAULT_AMBIGUITY_GUARD_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_AMBIGUITY_GUARD_MODE}).`)
  return DEFAULT_AMBIGUITY_GUARD_MODE
}

export function resolveAmbiguityGuardMode(env: NodeJS.ProcessEnv): AmbiguityGuardMode {
  return normalizeAmbiguityGuardMode(env.ASSISTANT_AMBIGUITY_GUARD)
}
