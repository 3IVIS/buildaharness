import { describe, it, expect } from 'vitest'
import { defaultWriteModels, suggestedModels } from './write-models.js'

describe('write models', () => {
  it('suggests the repo default first and never an empty list for a known backend', () => {
    expect(suggestedModels('anthropic')[0]).toMatch(/^claude-/)
    expect(suggestedModels('anthropic').length).toBeGreaterThan(1)
    expect(suggestedModels('openai')).toHaveLength(1)
    expect(suggestedModels('claude-cli')).toEqual(['sonnet', 'opus', 'haiku']) // the CLI's own aliases; an empty box uses the CLI's default
  })
  it('uses the configured model for the chat, and a smaller one for automatic checks where one is known', () => {
    const a = defaultWriteModels('anthropic', 'claude-opus-5-5')
    expect(a.chat).toBe('claude-opus-5-5')
    expect(a.auto).not.toBe(a.chat)
    const o = defaultWriteModels('openai')
    expect(o.auto).toBe(o.chat) // nothing smaller is known: the same, and Settings says so
    expect(defaultWriteModels('openai', '  my-model ').chat).toBe('my-model')
  })
})

describe('the Claude CLI backend has no model id of its own', () => {
  it('names the empty id and suggests the CLI aliases', async () => {
    const { modelLabel, suggestedModels, CLI_DEFAULT_LABEL } = await import('./write-models.js')
    expect(modelLabel('')).toBe(CLI_DEFAULT_LABEL)
    expect(modelLabel('  ')).toBe(CLI_DEFAULT_LABEL)
    expect(modelLabel('sonnet')).toBe('sonnet')
    expect(suggestedModels('claude-cli')).toEqual(['sonnet', 'opus', 'haiku'])
  })
})
