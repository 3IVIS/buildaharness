import { describe, it, expect } from 'vitest'
import { buildClaudePrompt, parseClaudeCliOutput } from './claude-cli-prompt.js'
import type { ChatMessage } from '@buildaharness/runtime'

describe('buildClaudePrompt', () => {
  it('collects system messages into systemPrompt and joins the rest as turns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'What time is it?' },
    ]
    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    expect(systemPrompt).toBe('You are helpful.')
    expect(prompt).toBe('Hi\n\nAssistant: Hello!\n\nWhat time is it?')
  })

  it('falls back to a non-whitespace systemPrompt when there are no system messages, since the Anthropic API rejects a whitespace-only one', () => {
    const { systemPrompt } = buildClaudePrompt([{ role: 'user', content: 'Hi' }])
    expect(systemPrompt.trim()).not.toBe('')
  })
})

describe('parseClaudeCliOutput', () => {
  it('extracts the "result" field from --output-format json stdout', () => {
    expect(parseClaudeCliOutput('{"result": "hello there"}')).toBe('hello there')
  })

  it('falls back to "content" when "result" is absent', () => {
    expect(parseClaudeCliOutput('{"content": "fallback text"}')).toBe('fallback text')
  })

  it('falls back to raw trimmed stdout when it is not valid JSON', () => {
    expect(parseClaudeCliOutput('  plain text reply  \n')).toBe('plain text reply')
  })
})
