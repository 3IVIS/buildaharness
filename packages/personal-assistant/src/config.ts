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
  /**
   * Node-level network containment for an approved run_shell_command execution (Decision 6,
   * plans/lexical_functions_hardening_plan.html Phase 4 step 2): the spawned command's
   * HTTP(S)_PROXY env vars are forced to point at a loopback-only proxy (see
   * network-containment.ts) that only relays a CONNECT/request whose target host matches an
   * entry here (exact match or subdomain). Undefined/empty denies all network access from an
   * approved shell command — the safe default, since no host is a legitimate target until the
   * user opts one in. This is a Node-level restriction, not an OS sandbox — see the plan's
   * Decision 6 for why that tradeoff was chosen (identical across CLI/desktop, no new
   * dependency) over real OS-native sandboxing or a container-per-command.
   */
  shellNetworkAllowlist?: string[]
  workspaceRoot?: string
  /**
   * When true, `turn()` gives the model a real `send_email` tool — every call staged for
   * approval exactly like `write_file` (adoption plan F2). Off by default: no send tool exists
   * unless a transport is also configured below. The model can only ever propose a message.
   */
  enableEmail: boolean
  /** Which transport delivers an approved email. `resend` needs `resendApiKey`; `smtp` needs `smtpHost`/`smtpPort` (+ `smtpUser`/`smtpPass` if the server requires auth). */
  emailProvider?: 'resend' | 'smtp'
  /** The sender address an approved email is delivered as. Required whenever `enableEmail` is set — the model never chooses it. */
  emailFrom?: string
  /**
   * Resend API key (https://resend.com). Stored at the same low trust boundary as `apiKey` /
   * `braveApiKey` — plaintext in config.json, not an OS keychain; SettingsScreen warns next to
   * the input the same way it does for `apiKey`.
   */
  resendApiKey?: string
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  /** SMTP password — same plaintext-in-config trust boundary as `resendApiKey` / `apiKey`. */
  smtpPass?: string
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
  /**
   * Session-scoped spend ceilings, enforced (not just reported) before each new turn starts —
   * see spend-cap.ts. Undefined (the default) preserves today's unbounded behavior; this is an
   * opt-in safety rail on top of what /cost already computes, not a new default constraint.
   */
  sessionCostLimitUsd?: number
  /** Secondary ceiling on completed turns this session — see SpendCapConfig's doc comment in spend-cap.ts for why this counts turns, not raw internal LLM calls. */
  sessionCallLimit?: number
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
  'shellNetworkAllowlist',
  'workspaceRoot',
  'enableEmail',
  'emailProvider',
  'emailFrom',
  'resendApiKey',
  'smtpHost',
  'smtpPort',
  'smtpUser',
  'smtpPass',
  'dangerouslySkipPermissions',
  'sessionCostLimitUsd',
  'sessionCallLimit',
]

/** Matches today's actual hardcoded defaults (proxy backend, ddg search, web/shell off) — this plan changes nothing for a caller that never touches config. */
export const DEFAULT_CONFIG: AssistantConfig = {
  llmBackend: 'proxy',
  proxyUrl: 'http://localhost:8787',
  authToken: '',
  enableWeb: false,
  searchBackend: 'ddg',
  enableShell: false,
  enableEmail: false,
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
  if (merged.enableEmail) {
    if (!merged.emailFrom) {
      throw new ConfigValidationError('enableEmail requires emailFrom (the sender address) to be set.')
    }
    if (merged.emailProvider === 'resend' && !merged.resendApiKey) {
      throw new ConfigValidationError('emailProvider "resend" requires resendApiKey to be set.')
    }
    if (merged.emailProvider === 'smtp' && (!merged.smtpHost || !merged.smtpPort)) {
      throw new ConfigValidationError('emailProvider "smtp" requires smtpHost and smtpPort to be set.')
    }
    if (!merged.emailProvider) {
      throw new ConfigValidationError('enableEmail requires emailProvider ("resend" or "smtp") to be set.')
    }
  }
}
