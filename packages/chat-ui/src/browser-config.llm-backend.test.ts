import { describe, expect, it } from 'vitest'
import { llmBackendFromEnvValue } from './browser-config'

describe('llmBackendFromEnvValue (desktop ASSISTANT_LLM_BACKEND)', () => {
  it('is no override when unset', () => {
    expect(llmBackendFromEnvValue(null)).toEqual({})
    expect(llmBackendFromEnvValue(undefined)).toEqual({})
  })

  it.each(['claude-cli', 'anthropic', 'openai', 'openrouter'] as const)('passes %s through', (value) => {
    expect(llmBackendFromEnvValue(value)).toEqual({ llmBackend: value })
  })

  it('falls back to proxy for an unrecognized value, like the CLI', () => {
    expect(llmBackendFromEnvValue('claude_cli')).toEqual({ llmBackend: 'proxy' })
    expect(llmBackendFromEnvValue('')).toEqual({ llmBackend: 'proxy' })
  })
})
