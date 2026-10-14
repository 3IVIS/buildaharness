import { LAYER_POLICY_MODES } from '@buildaharness/harness'
import type { AssistantConfig } from './config.js'
import { MEMORY_WRITE_MODES, resolveMemoryWriteMode } from './memory-governance.js'
import { normalizeOneLoopMode } from './one-loop-flag.js'
import { normalizeAskMode } from './ask-mode-flag.js'
import { normalizeAmbiguityGuardMode } from './ambiguity-guard-flag.js'
import { normalizePlanMode } from './plan-mode-flag.js'
import { normalizeTuiMode } from './tui-mode-flag.js'
import { normalizeUpdateCheckMode } from './update-check-flag.js'
import { normalizeGoalGraphMode } from './goal-graph-flag.js'
import { normalizePlanGraphMode } from './plan-graph-flag.js'
import { normalizeLayerPolicyMode } from './layer-policy-flag.js'
import { normalizeGoalGraphSuggestMode } from './goal-graph-suggest-flag.js'

/**
 * One table of the settings that can be pinned by an environment variable: which variable names it on each
 * surface and how a raw value becomes the config value. The CLI reads `process.env` (ASSISTANT_*), the web and
 * desktop builds read Vite's `import.meta.env` (VITE_ASSISTANT_*); both iterate this table, so a new key is one
 * entry and the two surfaces cannot disagree on how a value is read. Pure: no node:* and no DOM imports.
 */

export type EnvSurface = 'cli' | 'vite'

export interface EnvKeySpec {
  key: keyof AssistantConfig
  /** The variable the CLI reads. Absent when the key has no CLI env var. */
  cli?: string
  /** The build-time variable the web and desktop builds read. Absent when the key cannot be pinned there. */
  vite?: string
  /** `vite` names a runtime variable that is not in `import.meta.env` (the desktop reads ASSISTANT_LLM_BACKEND through a Tauri command): shown next to a read-only field, never read from the build. */
  viteDisplayOnly?: boolean
  /** Turns the raw string into the config value, or undefined to leave the key unset (after warning). `envName` is the variable's name on this surface, for warnings. */
  fromEnv(raw: string, envName: string, surface: EnvSurface): unknown
}

/** An unrecognised value (a typo included) falls back to 'proxy', never to some other valid-looking backend. */
export function normalizeLlmBackend(raw: string): NonNullable<AssistantConfig['llmBackend']> {
  switch (raw) {
    case 'claude-cli':
    case 'anthropic':
    case 'openai':
    case 'openrouter':
      return raw
    default:
      return 'proxy'
  }
}

/** Comma-separated hostname list, trimmed, empties dropped (shellNetworkAllowlist). */
export function parseShellNetworkAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
}

const str = (raw: string): string => raw
const num = (raw: string): number => Number(raw)
/**
 * Boolean variables, the same on both surfaces (decision D6): "1" or "true" is on, "0" or "false" is off, and anything
 * else (yes, True, a typo) is off with a warning. Fail-closed on purpose: a value that is not clearly "on" must never
 * switch on shell, email or the approval bypass.
 */
export function parseEnvBoolean(raw: string, envName: string): boolean {
  if (raw === '1' || raw === 'true') return true
  if (raw !== '0' && raw !== 'false') console.warn(`${envName}="${raw}" is not one of 1/true/0/false; treating it as off.`)
  return false
}
const bool = (raw: string, envName: string): boolean => parseEnvBoolean(raw, envName)

export const ENV_KEYS: readonly EnvKeySpec[] = [
  { key: 'llmBackend', cli: 'ASSISTANT_LLM_BACKEND', vite: 'ASSISTANT_LLM_BACKEND', viteDisplayOnly: true, fromEnv: normalizeLlmBackend },
  { key: 'proxyUrl', cli: 'ASSISTANT_PROXY_URL', vite: 'VITE_ASSISTANT_PROXY_URL', fromEnv: str },
  { key: 'authToken', cli: 'ASSISTANT_PROXY_TOKEN', vite: 'VITE_ASSISTANT_PROXY_TOKEN', fromEnv: str },
  { key: 'apiKey', cli: 'ASSISTANT_API_KEY', fromEnv: str },
  { key: 'model', cli: 'ASSISTANT_MODEL', vite: 'VITE_ASSISTANT_MODEL', fromEnv: str },
  { key: 'enableWeb', cli: 'ASSISTANT_ENABLE_WEB', vite: 'VITE_ASSISTANT_ENABLE_WEB', fromEnv: bool },
  {
    key: 'webBackend',
    vite: 'VITE_ASSISTANT_WEB_BACKEND',
    fromEnv: (raw, envName) => {
      if (raw === 'proxy' || raw === 'direct') return raw
      console.warn(`Unrecognized ${envName} "${raw}" — ignoring, falling back to the default.`)
      return undefined
    },
  },
  { key: 'braveApiKey', cli: 'BRAVE_SEARCH_API_KEY', fromEnv: str },
  { key: 'enableShell', cli: 'ASSISTANT_ENABLE_SHELL', fromEnv: bool },
  { key: 'shellTimeoutMs', cli: 'ASSISTANT_SHELL_TIMEOUT_MS', fromEnv: num },
  { key: 'shellNetworkAllowlist', cli: 'ASSISTANT_SHELL_NETWORK_ALLOWLIST', fromEnv: parseShellNetworkAllowlist },
  { key: 'workspaceRoot', cli: 'ASSISTANT_WORKSPACE_DIR', fromEnv: str },
  { key: 'enableEmail', cli: 'ASSISTANT_ENABLE_EMAIL', fromEnv: bool },
  { key: 'emailProvider', cli: 'ASSISTANT_EMAIL_PROVIDER', fromEnv: (raw) => (raw === 'smtp' ? 'smtp' : 'resend') },
  { key: 'emailFrom', cli: 'ASSISTANT_EMAIL_FROM', fromEnv: str },
  { key: 'resendApiKey', cli: 'ASSISTANT_RESEND_API_KEY', fromEnv: str },
  { key: 'smtpHost', cli: 'ASSISTANT_SMTP_HOST', fromEnv: str },
  { key: 'smtpPort', cli: 'ASSISTANT_SMTP_PORT', fromEnv: num },
  { key: 'smtpUser', cli: 'ASSISTANT_SMTP_USER', fromEnv: str },
  { key: 'smtpPass', cli: 'ASSISTANT_SMTP_PASS', fromEnv: str },
  { key: 'dangerouslySkipPermissions', cli: 'ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS', fromEnv: bool },
  { key: 'sessionCostLimitUsd', cli: 'ASSISTANT_SESSION_COST_LIMIT_USD', fromEnv: num },
  { key: 'sessionCallLimit', cli: 'ASSISTANT_SESSION_CALL_LIMIT', fromEnv: num },
  { key: 'memoryBudgetChars', cli: 'ASSISTANT_MEMORY_BUDGET_CHARS', fromEnv: num },
  {
    key: 'memoryWriteMode',
    cli: 'ASSISTANT_MEMORY_WRITE_MODE',
    vite: 'VITE_ASSISTANT_MEMORY_WRITE_MODE',
    fromEnv: (raw, envName) => {
      const resolved = resolveMemoryWriteMode(raw)
      // Warn-and-default like every other mode flag: an unrecognised value must be visible, not silently a different mode.
      if (!(MEMORY_WRITE_MODES as readonly string[]).includes(raw)) console.warn(`${envName}="${raw}" is not one of ${MEMORY_WRITE_MODES.join('/')}; using "${resolved}".`)
      return resolved
    },
  },
  { key: 'oneLoopMode', cli: 'ASSISTANT_ONE_LOOP', vite: 'VITE_ASSISTANT_ONE_LOOP', fromEnv: normalizeOneLoopMode },
  { key: 'askMode', cli: 'ASSISTANT_ASK_MODE', vite: 'VITE_ASSISTANT_ASK_MODE', fromEnv: normalizeAskMode },
  { key: 'planMode', cli: 'ASSISTANT_PLAN_MODE', vite: 'VITE_ASSISTANT_PLAN_MODE', fromEnv: normalizePlanMode },
  { key: 'ambiguityGuardMode', cli: 'ASSISTANT_AMBIGUITY_GUARD', fromEnv: normalizeAmbiguityGuardMode },
  { key: 'tuiMode', cli: 'ASSISTANT_TUI', fromEnv: normalizeTuiMode },
  { key: 'updateCheck', cli: 'ASSISTANT_UPDATE_CHECK', fromEnv: normalizeUpdateCheckMode },
  { key: 'activeProject', cli: 'ASSISTANT_ACTIVE_PROJECT', fromEnv: str },
  { key: 'goalGraphMode', cli: 'ASSISTANT_GOAL_GRAPH', vite: 'VITE_ASSISTANT_GOAL_GRAPH', fromEnv: normalizeGoalGraphMode },
  { key: 'planGraphMode', cli: 'ASSISTANT_PLAN_GRAPH', vite: 'VITE_ASSISTANT_PLAN_GRAPH', fromEnv: normalizePlanGraphMode },
  { key: 'layerPolicyMode', cli: 'ASSISTANT_LAYER_POLICY', vite: 'VITE_ASSISTANT_LAYER_POLICY', fromEnv: normalizeLayerPolicyMode },
  { key: 'goalGraphSuggestMode', cli: 'ASSISTANT_GOAL_GRAPH_SUGGEST', vite: 'VITE_ASSISTANT_GOAL_GRAPH_SUGGEST', fromEnv: normalizeGoalGraphSuggestMode },
]

/** The variable that can pin `key` on `surface`, for showing next to a value or a read-only field. */
export function envVarFor(surface: EnvSurface): Partial<Record<keyof AssistantConfig, string>> {
  const out: Partial<Record<keyof AssistantConfig, string>> = {}
  for (const spec of ENV_KEYS) {
    const name = surface === 'cli' ? spec.cli : spec.vite
    if (name) out[spec.key] = name
  }
  return out
}

/**
 * Builds the `overrides` argument for resolveConfig() from one surface's environment, only including a key whose
 * variable is actually set, so an absent variable never shadows a persisted value. "Set" differs by surface on
 * purpose: the CLI treats any defined value (even empty) as set; a Vite build defines every VITE_ var as an empty
 * string when it is unset, so there an empty value means unset.
 */
export function envOverridesFrom(env: Readonly<Record<string, string | undefined>>, surface: EnvSurface): Partial<AssistantConfig> {
  const overrides: Record<string, unknown> = {}
  for (const spec of ENV_KEYS) {
    const name = surface === 'cli' ? spec.cli : spec.vite
    if (!name || (surface === 'vite' && spec.viteDisplayOnly)) continue
    const raw = env[name]
    if (surface === 'cli' ? raw === undefined : !raw) continue
    const value = spec.fromEnv(raw as string, name, surface)
    if (value !== undefined) overrides[spec.key] = value
  }
  return overrides as Partial<AssistantConfig>
}

/** Keys whose values are a fixed set of words, for the strict /config set parser (and any picker). */
export const ENUM_CHOICES: Partial<Record<keyof AssistantConfig, readonly string[]>> = {
  memoryWriteMode: MEMORY_WRITE_MODES,
  oneLoopMode: ['enabled', 'disabled'],
  askMode: ['enabled', 'disabled'],
  ambiguityGuardMode: ['enabled', 'disabled'],
  planMode: ['gated', 'legacy'],
  tuiMode: ['enabled', 'disabled'],
  updateCheck: ['enabled', 'disabled'],
  theme: ['system', 'dark', 'light'],
  goalGraphMode: ['enabled', 'disabled'],
  planGraphMode: ['enabled', 'disabled'],
  layerPolicyMode: LAYER_POLICY_MODES,
  goalGraphSuggestMode: ['enabled', 'disabled'],
}

/** `"a" or "b"`, or `"a", "b" or "c"`. */
export function formatChoices(choices: readonly string[]): string {
  const quoted = choices.map((c) => `"${c}"`)
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`
}
