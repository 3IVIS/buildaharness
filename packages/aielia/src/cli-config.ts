import type { AssistantConfig } from './config.js'
import { CONFIG_KEYS } from './config.js'
import { redactUrlCredentials } from './redact-url.js'
import { ENUM_CHOICES, envOverridesFrom, envVarFor, formatChoices, parseShellNetworkAllowlist } from './config-keys.js'

/**
 * Pure logic backing cli.ts's /config command family — split out so it's unit-testable in
 * isolation, the same way error-classifier.ts and node-display-names.ts are split out of
 * cli.ts for the same reason. cli.ts itself stays thin glue (readline dispatch, ConfigStore
 * I/O, rebuilding the assistant) on top of these functions.
 */

export { CONFIG_KEYS }

/** Never printed in full by formatConfigValue — /config shows these masked regardless of value. */
export const SECRET_CONFIG_KEYS: ReadonlySet<keyof AssistantConfig> = new Set(['authToken', 'apiKey', 'braveApiKey', 'resendApiKey', 'smtpPass'])

/** Which env var, if any, can pin a given key — shown next to a value in /config's listing when that var is set. */
export const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>> = envVarFor('cli')

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
  return envOverridesFrom(env, 'cli')
}

/**
 * Numeric settings that must be positive, finite numbers. An environment variable is parsed with a bare
 * `Number(...)`, so `ASSISTANT_SESSION_COST_LIMIT_USD=abc` arrives as NaN — and every `spent >= NaN` check is
 * false, which silently turns a spending ceiling OFF. Returns the problems found (empty when all are fine) so
 * startup can refuse a broken limit instead of running unguarded.
 */
const POSITIVE_NUMERIC_KEYS = ['sessionCostLimitUsd', 'sessionCallLimit', 'shellTimeoutMs', 'memoryBudgetChars', 'smtpPort'] as const

export function findInvalidNumericSettings(config: AssistantConfig): string[] {
  const problems: string[] = []
  for (const key of POSITIVE_NUMERIC_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      const envVar = ENV_VAR_FOR_CONFIG_KEY[key]
      problems.push(`${key} must be a positive number (got ${JSON.stringify(value)})${envVar ? `; check ${envVar}` : ''}.`)
    }
  }
  return problems
}

/** Thrown by parseConfigValue on a value that doesn't fit the target key's type — cli.ts reports .message and leaves the config unchanged. */
export class ConfigValueParseError extends Error {}

/** Parses a raw `/config set <key> <value>` string into the type AssistantConfig[key] expects. */
export function parseConfigValue(key: keyof AssistantConfig, raw: string): unknown {
  switch (key) {
    case 'enableWeb':
    case 'enableShell':
    case 'enableEmail':
    case 'dangerouslySkipPermissions':
      if (raw !== 'true' && raw !== 'false') throw new ConfigValueParseError(`${key} must be "true" or "false"`)
      return raw === 'true'
    case 'emailProvider':
      if (raw !== 'resend' && raw !== 'smtp') throw new ConfigValueParseError('emailProvider must be "resend" or "smtp"')
      return raw
    case 'smtpPort': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new ConfigValueParseError('smtpPort must be a positive integer')
      return n
    }
    case 'shellTimeoutMs': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) throw new ConfigValueParseError('shellTimeoutMs must be a positive number')
      return n
    }
    case 'shellNetworkAllowlist':
      return parseShellNetworkAllowlist(raw)
    case 'sessionCostLimitUsd': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) throw new ConfigValueParseError('sessionCostLimitUsd must be a positive number')
      return n
    }
    case 'memoryBudgetChars': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new ConfigValueParseError('memoryBudgetChars must be a positive integer')
      return n
    }
    case 'sessionCallLimit': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new ConfigValueParseError('sessionCallLimit must be a positive integer')
      return n
    }
    case 'llmBackend':
      if (raw !== 'proxy' && raw !== 'claude-cli' && raw !== 'anthropic' && raw !== 'openai' && raw !== 'openrouter') {
        throw new ConfigValueParseError('llmBackend must be one of "proxy", "claude-cli", "anthropic", "openai", "openrouter"')
      }
      return raw
    case 'layers':
      throw new ConfigValueParseError('layers is edited with /layers (e.g. /layers off decomposition_reframe), not /config set')
    default: {
      // The fixed-word keys (modes, theme) share their choices with the pickers: config-keys.ts's ENUM_CHOICES.
      const choices = ENUM_CHOICES[key]
      if (choices && !choices.includes(raw)) throw new ConfigValueParseError(`${key} must be ${formatChoices(choices)}`)
      return raw
    }
  }
}

function formatConfigValue(key: keyof AssistantConfig, config: AssistantConfig): string {
  const value = config[key]
  if (value === undefined || value === '') return '(not set)'
  if (SECRET_CONFIG_KEYS.has(key)) return '********'
  if (key === 'layers') {
    const changed = Object.entries(config.layers ?? {})
    return changed.length === 0 ? '(defaults; see /layers)' : changed.map(([id, on]) => `${id}=${on ? 'on' : 'off'}`).join(' ')
  }
  if (key === 'proxyUrl') return redactUrlCredentials(String(value))
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

export { redactUrlCredentials }
