/**
 * Shared configuration shape for PersonalAssistant, used identically by the CLI, plain-browser
 * chat-ui, and Tauri desktop front ends. Each surface supplies its own ConfigStore (a thin
 * persistence backend — see node-config-store.ts / browser-config-store.ts / tauri-config-store.ts)
 * plus its own "overrides" (env vars for the CLI, VITE_* build-time vars for chat-ui); resolveConfig
 * applies one shared precedence rule so all three surfaces agree on what a given set of inputs means.
 */

export interface AssistantConfig {
  llmBackend: 'proxy' | 'claude-cli' | 'anthropic' | 'openai' | 'openrouter'
  proxyUrl: string
  authToken: string
  /**
   * API key for the three direct-to-provider backends (anthropic/openai/openrouter) — one
   * generic field reused across all three, mirroring authToken already being a single field
   * for the proxy's bearer token rather than one field per possible deployment. Switching
   * backends means re-entering the key, an accepted simplification consistent with this
   * app's "keep config flat" convention.
   *
   * Stored at the same (low) trust boundary as authToken/braveApiKey — plaintext, not an OS
   * keychain. Unlike those two, this is a *real* provider key, not a self-hosted proxy token,
   * so the risk of a leaked config file is materially bigger; SettingsScreen must warn about
   * this plainly next to the input (see dangerouslySkipPermissions' warning callout).
   */
  apiKey?: string
  model?: string
  enableWeb: boolean
  searchBackend: 'ddg' | 'brave'
  braveApiKey?: string
  enableShell: boolean
  shellTimeoutMs?: number
  workspaceRoot?: string
  /**
   * Equivalent of Claude Code's own --dangerously-skip-permissions: when true, both approval
   * gates PersonalAssistant otherwise always enforces — the message-level risk gate
   * (risk-classifier.ts) and write_file/run_shell_command's per-call staging (file-tools.ts/
   * shell-tools.ts) — execute immediately instead of returning `needs_approval`. The
   * sandboxing itself (workspace-root path validation, SSRF guard, shell env allowlist,
   * output truncation, timeout) is unaffected — this only skips asking, never the underlying
   * safety limits. Off by default; named to match Claude Code's own flag so it reads as
   * exactly as dangerous as it is.
   */
  dangerouslySkipPermissions: boolean
}

/** Every AssistantConfig key, in the order every surface's settings UI/listing renders them. */
export const CONFIG_KEYS: readonly (keyof AssistantConfig)[] = [
  'llmBackend',
  'proxyUrl',
  'authToken',
  'apiKey',
  'model',
  'enableWeb',
  'searchBackend',
  'braveApiKey',
  'enableShell',
  'shellTimeoutMs',
  'workspaceRoot',
  'dangerouslySkipPermissions',
]

/** Matches today's actual hardcoded defaults (proxy backend, ddg search, web/shell off) — this plan changes nothing for a caller that never touches config. */
export const DEFAULT_CONFIG: AssistantConfig = {
  llmBackend: 'proxy',
  proxyUrl: 'http://localhost:8787',
  authToken: '',
  enableWeb: false,
  searchBackend: 'ddg',
  enableShell: false,
  dangerouslySkipPermissions: false,
}

/** A persistence backend for AssistantConfig — one implementation per surface (Node JSON file, localStorage, Tauri fs). */
export interface ConfigStore {
  load(): Promise<Partial<AssistantConfig>>
  /** Merges patch onto whatever is already persisted — never a blind overwrite of unrelated keys. */
  save(patch: Partial<AssistantConfig>): Promise<void>
}

export interface ResolvedConfig {
  config: AssistantConfig
  /** Keys whose value came from `overrides` (env var / build-time var) rather than persisted config or the default — these should render read-only in any settings UI. */
  overriddenKeys: Set<keyof AssistantConfig>
}

/**
 * Precedence: overrides > persisted > DEFAULT_CONFIG, applied key by key. A key present in
 * `overrides` but set to `undefined` is treated as absent — it must never shadow a persisted
 * value, which is what would happen if this just did `{ ...DEFAULT_CONFIG, ...persisted, ...overrides }`.
 */
export function resolveConfig(persisted: Partial<AssistantConfig> = {}, overrides: Partial<AssistantConfig> = {}): ResolvedConfig {
  const config = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(persisted) as (keyof AssistantConfig)[]) {
    const value = persisted[key]
    if (value !== undefined) Object.assign(config, { [key]: value })
  }

  const overriddenKeys = new Set<keyof AssistantConfig>()
  for (const key of Object.keys(overrides) as (keyof AssistantConfig)[]) {
    const value = overrides[key]
    if (value !== undefined) {
      Object.assign(config, { [key]: value })
      overriddenKeys.add(key)
    }
  }

  return { config, overriddenKeys }
}

/** Thrown by validateConfig instead of returning a falsy value, so callers can't accidentally persist a rejected patch. */
export class ConfigValidationError extends Error {}

/**
 * Validates a prospective patch against the config it would apply to (not just the patch in
 * isolation) — e.g. `{ searchBackend: 'brave' }` is valid if `braveApiKey` is already persisted
 * from an earlier `set`, and invalid if not. Callers (CLI's /config set, chat-ui's SettingsScreen)
 * run this before persisting, so a broken combination is rejected before it's ever written.
 */
const DIRECT_API_BACKENDS: ReadonlySet<AssistantConfig['llmBackend']> = new Set(['anthropic', 'openai', 'openrouter'])

export function validateConfig(patch: Partial<AssistantConfig>, existing: AssistantConfig): void {
  const merged = { ...existing, ...patch }
  if (merged.searchBackend === 'brave' && !merged.braveApiKey) {
    throw new ConfigValidationError('searchBackend "brave" requires braveApiKey to be set.')
  }
  if (DIRECT_API_BACKENDS.has(merged.llmBackend) && !merged.apiKey) {
    throw new ConfigValidationError(`llmBackend "${merged.llmBackend}" requires apiKey to be set.`)
  }
}
