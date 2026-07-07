import { describe, it, expect } from 'vitest'
import { resolveConfig, validateConfig, ConfigValidationError, DEFAULT_CONFIG } from './config.js'

describe('resolveConfig', () => {
  it('falls back to DEFAULT_CONFIG when nothing is persisted and no overrides are given', () => {
    const { config, overriddenKeys } = resolveConfig()
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(overriddenKeys.size).toBe(0)
  })

  it('persisted values win over defaults', () => {
    const { config } = resolveConfig({ enableWeb: true, searchBackend: 'brave', braveApiKey: 'k' })
    expect(config.enableWeb).toBe(true)
    expect(config.searchBackend).toBe('brave')
    expect(config.braveApiKey).toBe('k')
  })

  it('overrides win over persisted, independently per key', () => {
    const { config, overriddenKeys } = resolveConfig(
      { enableWeb: true, proxyUrl: 'http://persisted:1' },
      { proxyUrl: 'http://override:2' },
    )
    expect(config.proxyUrl).toBe('http://override:2')
    expect(config.enableWeb).toBe(true) // untouched by overrides, still comes from persisted
    expect(overriddenKeys.has('proxyUrl')).toBe(true)
    expect(overriddenKeys.has('enableWeb')).toBe(false)
  })

  it('a key present in overrides but set to undefined does not shadow a persisted value', () => {
    const { config, overriddenKeys } = resolveConfig({ model: 'persisted-model' }, { model: undefined })
    expect(config.model).toBe('persisted-model')
    expect(overriddenKeys.has('model')).toBe(false)
  })
})

describe('validateConfig', () => {
  it('rejects searchBackend: brave with no braveApiKey in the patch or existing config', () => {
    expect(() => validateConfig({ searchBackend: 'brave' }, DEFAULT_CONFIG)).toThrow(ConfigValidationError)
  })

  it('accepts a patch that sets braveApiKey and searchBackend together', () => {
    expect(() => validateConfig({ searchBackend: 'brave', braveApiKey: 'k' }, DEFAULT_CONFIG)).not.toThrow()
  })

  it('accepts searchBackend: brave when braveApiKey is already present on the existing config', () => {
    const existing = { ...DEFAULT_CONFIG, braveApiKey: 'k' }
    expect(() => validateConfig({ searchBackend: 'brave' }, existing)).not.toThrow()
  })

  it('does not throw for patches unrelated to search backend', () => {
    expect(() => validateConfig({ enableShell: true }, DEFAULT_CONFIG)).not.toThrow()
  })

  it.each(['anthropic', 'openai', 'openrouter'] as const)('rejects llmBackend "%s" with no apiKey in the patch or existing config', (backend) => {
    expect(() => validateConfig({ llmBackend: backend }, DEFAULT_CONFIG)).toThrow(ConfigValidationError)
  })

  it('accepts a patch that sets apiKey and a direct llmBackend together', () => {
    expect(() => validateConfig({ llmBackend: 'openai', apiKey: 'sk-test' }, DEFAULT_CONFIG)).not.toThrow()
  })

  it('accepts a direct llmBackend when apiKey is already present on the existing config', () => {
    const existing = { ...DEFAULT_CONFIG, apiKey: 'sk-test' }
    expect(() => validateConfig({ llmBackend: 'anthropic' }, existing)).not.toThrow()
  })

  it('does not require apiKey for proxy or claude-cli backends', () => {
    expect(() => validateConfig({ llmBackend: 'proxy' }, DEFAULT_CONFIG)).not.toThrow()
    expect(() => validateConfig({ llmBackend: 'claude-cli' }, DEFAULT_CONFIG)).not.toThrow()
  })
})
