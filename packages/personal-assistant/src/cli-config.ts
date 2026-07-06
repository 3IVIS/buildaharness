import type { AssistantConfig } from './config.js'
import { CONFIG_KEYS } from './config.js'

/**
 * Pure logic backing cli.ts's /config command family — split out so it's unit-testable in
 * isolation, the same way error-classifier.ts and node-display-names.ts are split out of
 * cli.ts for the same reason. cli.ts itself stays thin glue (readline dispatch, ConfigStore
 * I/O, rebuilding the assistant) on top of these functions.
 */

export { CONFIG_KEYS }

/** Never printed in full by formatConfigValue — /config shows these masked regardless of value. */
export const SECRET_CONFIG_KEYS: ReadonlySet<keyof AssistantConfig> = new Set(['authToken', 'braveApiKey'])

/** Which env var, if any, can pin a given key — shown next to a value in /config's listing when that var is set. */
export const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>> = {
  llmBackend: 'ASSISTANT_LLM_BACKEND',
  proxyUrl: 'ASSISTANT_PROXY_URL',
  authToken: 'ASSISTANT_PROXY_TOKEN',
  model: 'ASSISTANT_MODEL',
  enableWeb: 'ASSISTANT_ENABLE_WEB',
  searchBackend: 'ASSISTANT_SEARCH_BACKEND',
  braveApiKey: 'BRAVE_SEARCH_API_KEY',
  enableShell: 'ASSISTANT_ENABLE_SHELL',
  shellTimeoutMs: 'ASSISTANT_SHELL_TIMEOUT_MS',
  workspaceRoot: 'ASSISTANT_WORKSPACE_DIR',
}

export function isConfigKey(key: string): key is keyof AssistantConfig {
  return (CONFIG_KEYS as readonly string[]).includes(key)
}

/**
 * Builds the `overrides` argument for resolveConfig() from process.env — only includes a key
 * when its env var is actually set, so an absent env var can never shadow a persisted config
 * value with a falsy default. Mirrors the exact env vars/parsing cli.ts read individually
 * before this module existed (ASSISTANT_ENABLE_WEB/ASSISTANT_ENABLE_SHELL must be exactly "1").
 */
export function envOverridesFromProcessEnv(env: NodeJS.ProcessEnv): Partial<AssistantConfig> {
  const overrides: Partial<AssistantConfig> = {}
  if (env.ASSISTANT_LLM_BACKEND !== undefined) overrides.llmBackend = env.ASSISTANT_LLM_BACKEND === 'claude-cli' ? 'claude-cli' : 'proxy'
  if (env.ASSISTANT_PROXY_URL !== undefined) overrides.proxyUrl = env.ASSISTANT_PROXY_URL
  if (env.ASSISTANT_PROXY_TOKEN !== undefined) overrides.authToken = env.ASSISTANT_PROXY_TOKEN
  if (env.ASSISTANT_MODEL !== undefined) overrides.model = env.ASSISTANT_MODEL
  if (env.ASSISTANT_ENABLE_WEB !== undefined) overrides.enableWeb = env.ASSISTANT_ENABLE_WEB === '1'
  if (env.ASSISTANT_SEARCH_BACKEND !== undefined) overrides.searchBackend = env.ASSISTANT_SEARCH_BACKEND === 'brave' ? 'brave' : 'ddg'
  if (env.BRAVE_SEARCH_API_KEY !== undefined) overrides.braveApiKey = env.BRAVE_SEARCH_API_KEY
  if (env.ASSISTANT_ENABLE_SHELL !== undefined) overrides.enableShell = env.ASSISTANT_ENABLE_SHELL === '1'
  if (env.ASSISTANT_SHELL_TIMEOUT_MS !== undefined) overrides.shellTimeoutMs = Number(env.ASSISTANT_SHELL_TIMEOUT_MS)
  if (env.ASSISTANT_WORKSPACE_DIR !== undefined) overrides.workspaceRoot = env.ASSISTANT_WORKSPACE_DIR
  return overrides
}

/** Thrown by parseConfigValue on a value that doesn't fit the target key's type — cli.ts reports .message and leaves the config unchanged. */
export class ConfigValueParseError extends Error {}

/** Parses a raw `/config set <key> <value>` string into the type AssistantConfig[key] expects. */
export function parseConfigValue(key: keyof AssistantConfig, raw: string): unknown {
  switch (key) {
    case 'enableWeb':
    case 'enableShell':
      if (raw !== 'true' && raw !== 'false') throw new ConfigValueParseError(`${key} must be "true" or "false"`)
      return raw === 'true'
    case 'shellTimeoutMs': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) throw new ConfigValueParseError('shellTimeoutMs must be a positive number')
      return n
    }
    case 'llmBackend':
      if (raw !== 'proxy' && raw !== 'claude-cli') throw new ConfigValueParseError('llmBackend must be "proxy" or "claude-cli"')
      return raw
    case 'searchBackend':
      if (raw !== 'ddg' && raw !== 'brave') throw new ConfigValueParseError('searchBackend must be "ddg" or "brave"')
      return raw
    default:
      return raw
  }
}

function formatConfigValue(key: keyof AssistantConfig, config: AssistantConfig): string {
  const value = config[key]
  if (value === undefined || value === '') return '(not set)'
  if (SECRET_CONFIG_KEYS.has(key)) return '********'
  return String(value)
}

/** Renders /config's full listing as a single multi-line string — cli.ts just console.logs the result. */
export function formatConfigListing(config: AssistantConfig, overriddenKeys: ReadonlySet<keyof AssistantConfig>): string {
  const lines = CONFIG_KEYS.map((key) => {
    const pin = overriddenKeys.has(key) ? `  (env-pinned: ${ENV_VAR_FOR_CONFIG_KEY[key]})` : ''
    return `  ${key.padEnd(14)} ${formatConfigValue(key, config)}${pin}`
  })
  return lines.join('\n')
}
