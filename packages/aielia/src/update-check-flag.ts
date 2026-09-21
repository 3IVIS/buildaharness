/**
 * Pure logic backing the passive update check's opt-out (`ASSISTANT_UPDATE_CHECK` /
 * `/config set updateCheck`) — same shape as tui-mode-flag.ts/one-loop-flag.ts. 'enabled' is the
 * default; 'disabled' silences only the *passive* background check — the explicit
 * `aielia update` command still works either way.
 */
export type UpdateCheckMode = 'enabled' | 'disabled'

export const DEFAULT_UPDATE_CHECK_MODE: UpdateCheckMode = 'enabled'

/** An unset/empty value falls back silently; an unrecognized one falls back with a warning naming `varName`. */
export function normalizeUpdateCheckMode(raw: string | undefined, varName = 'ASSISTANT_UPDATE_CHECK'): UpdateCheckMode {
  if (raw === undefined || raw === '') return DEFAULT_UPDATE_CHECK_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_UPDATE_CHECK_MODE}).`)
  return DEFAULT_UPDATE_CHECK_MODE
}

export function resolveUpdateCheckMode(env: NodeJS.ProcessEnv): UpdateCheckMode {
  return normalizeUpdateCheckMode(env.ASSISTANT_UPDATE_CHECK)
}
