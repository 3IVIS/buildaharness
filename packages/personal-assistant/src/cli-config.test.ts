import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from './config.js'
import {
  isConfigKey,
  envOverridesFromProcessEnv,
  parseConfigValue,
  ConfigValueParseError,
  formatConfigListing,
} from './cli-config.js'

describe('isConfigKey', () => {
  it('accepts every real AssistantConfig key', () => {
    expect(isConfigKey('enableWeb')).toBe(true)
    expect(isConfigKey('braveApiKey')).toBe(true)
  })

  it('rejects an unknown key', () => {
    expect(isConfigKey('notARealKey')).toBe(false)
  })
})

describe('envOverridesFromProcessEnv', () => {
  it('returns {} when no relevant env vars are set', () => {
    expect(envOverridesFromProcessEnv({})).toEqual({})
  })

  it('only includes keys whose env var is actually present', () => {
    const overrides = envOverridesFromProcessEnv({ ASSISTANT_ENABLE_WEB: '1' })
    expect(overrides).toEqual({ enableWeb: true })
  })

  it('ASSISTANT_ENABLE_WEB/ASSISTANT_ENABLE_SHELL must be exactly "1"', () => {
    expect(envOverridesFromProcessEnv({ ASSISTANT_ENABLE_WEB: '0' })).toEqual({ enableWeb: false })
    expect(envOverridesFromProcessEnv({ ASSISTANT_ENABLE_SHELL: 'yes' })).toEqual({ enableShell: false })
  })

  it('parses ASSISTANT_SHELL_TIMEOUT_MS as a number', () => {
    expect(envOverridesFromProcessEnv({ ASSISTANT_SHELL_TIMEOUT_MS: '5000' })).toEqual({ shellTimeoutMs: 5000 })
  })

  it('ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS must be exactly "1"', () => {
    expect(envOverridesFromProcessEnv({ ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS: '1' })).toEqual({ dangerouslySkipPermissions: true })
    expect(envOverridesFromProcessEnv({ ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS: 'yes' })).toEqual({ dangerouslySkipPermissions: false })
  })

  it('defaults ASSISTANT_SEARCH_BACKEND to ddg for any value other than "brave"', () => {
    expect(envOverridesFromProcessEnv({ ASSISTANT_SEARCH_BACKEND: 'bing' })).toEqual({ searchBackend: 'ddg' })
    expect(envOverridesFromProcessEnv({ ASSISTANT_SEARCH_BACKEND: 'brave' })).toEqual({ searchBackend: 'brave' })
  })
})

describe('parseConfigValue', () => {
  it('parses valid booleans for enableWeb/enableShell/dangerouslySkipPermissions', () => {
    expect(parseConfigValue('enableWeb', 'true')).toBe(true)
    expect(parseConfigValue('enableShell', 'false')).toBe(false)
    expect(parseConfigValue('dangerouslySkipPermissions', 'true')).toBe(true)
  })

  it('rejects a non-boolean value for enableWeb', () => {
    expect(() => parseConfigValue('enableWeb', 'yes')).toThrow(ConfigValueParseError)
  })

  it('parses a valid positive number for shellTimeoutMs', () => {
    expect(parseConfigValue('shellTimeoutMs', '30000')).toBe(30000)
  })

  it('rejects a non-numeric or non-positive shellTimeoutMs', () => {
    expect(() => parseConfigValue('shellTimeoutMs', 'abc')).toThrow(ConfigValueParseError)
    expect(() => parseConfigValue('shellTimeoutMs', '-5')).toThrow(ConfigValueParseError)
  })

  it('rejects an invalid searchBackend/llmBackend', () => {
    expect(() => parseConfigValue('searchBackend', 'bing')).toThrow(ConfigValueParseError)
    expect(() => parseConfigValue('llmBackend', 'other')).toThrow(ConfigValueParseError)
  })

  it('accepts a valid searchBackend/llmBackend', () => {
    expect(parseConfigValue('searchBackend', 'brave')).toBe('brave')
    expect(parseConfigValue('llmBackend', 'claude-cli')).toBe('claude-cli')
  })

  it('passes free-form string fields through unchanged', () => {
    expect(parseConfigValue('proxyUrl', 'http://example.com')).toBe('http://example.com')
  })
})

describe('formatConfigListing', () => {
  it('masks secret keys regardless of value', () => {
    const listing = formatConfigListing({ ...DEFAULT_CONFIG, braveApiKey: 'sk-super-secret' }, new Set())
    expect(listing).toContain('********')
    expect(listing).not.toContain('sk-super-secret')
  })

  it('shows "(not set)" for an absent optional field', () => {
    const listing = formatConfigListing(DEFAULT_CONFIG, new Set())
    expect(listing).toMatch(/model\s+\(not set\)/)
  })

  it('annotates env-pinned keys with the responsible env var', () => {
    const listing = formatConfigListing(DEFAULT_CONFIG, new Set(['enableWeb']))
    expect(listing).toContain('(env-pinned: ASSISTANT_ENABLE_WEB)')
  })
})
