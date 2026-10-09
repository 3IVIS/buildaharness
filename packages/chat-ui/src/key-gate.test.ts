import { describe, expect, it } from 'vitest'
import { hasModelCredentials, isKeyMissing, requiresOwnKey } from './key-gate'

const env = (v: Record<string, string>) => v as unknown as ImportMetaEnv

describe('requiresOwnKey', () => {
  it('is on only for the exact string "true"', () => {
    expect(requiresOwnKey(env({ VITE_ASSISTANT_REQUIRE_KEY: 'true' }))).toBe(true)
    expect(requiresOwnKey(env({ VITE_ASSISTANT_REQUIRE_KEY: 'false' }))).toBe(false)
    expect(requiresOwnKey(env({ VITE_ASSISTANT_REQUIRE_KEY: '1' }))).toBe(false)
    expect(requiresOwnKey(env({}))).toBe(false)
  })
})

describe('hasModelCredentials', () => {
  it('needs a non-blank apiKey for the direct providers', () => {
    for (const llmBackend of ['anthropic', 'openai', 'openrouter'] as const) {
      expect(hasModelCredentials({ llmBackend, apiKey: 'sk-x' })).toBe(true)
      expect(hasModelCredentials({ llmBackend, apiKey: '   ' })).toBe(false)
      expect(hasModelCredentials({ llmBackend })).toBe(false)
    }
  })
  it('needs an auth token for the proxy backend', () => {
    expect(hasModelCredentials({ llmBackend: 'proxy' })).toBe(false)
    expect(hasModelCredentials({ llmBackend: 'proxy', authToken: 'tok' })).toBe(true)
  })
  it('does not ask for a key on claude-cli', () => {
    expect(hasModelCredentials({ llmBackend: 'claude-cli' })).toBe(true)
  })
})

describe('isKeyMissing', () => {
  const noKey = { llmBackend: 'proxy' as const }
  it('is true only on the hosted browser build with no credentials', () => {
    expect(isKeyMissing(true, false, noKey)).toBe(true)
  })
  it('never fires on builds that do not require a key', () => {
    expect(isKeyMissing(false, false, noKey)).toBe(false)
  })
  it('never fires on the desktop app', () => {
    expect(isKeyMissing(true, true, noKey)).toBe(false)
  })
  it('clears once a key is saved', () => {
    expect(isKeyMissing(true, false, { llmBackend: 'anthropic', apiKey: 'sk-ant-x' })).toBe(false)
  })
})
