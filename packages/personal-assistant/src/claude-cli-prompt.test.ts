import { describe, it, expect } from 'vitest'
import { buildClaudePrompt, parseClaudeCliOutput, stripJsonCodeFence } from './claude-cli-prompt.js'
import type { ChatMessage } from '@buildaharness/runtime'

describe('buildClaudePrompt', () => {
  it('a single message (no history yet) is passed through as bare content, no framing', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    expect(systemPrompt).toBe('You are helpful.')
    expect(prompt).toBe('Hi')
  })

  // Was previously a bare 'Hi\n\nAssistant: Hello!\n\nWhat time is it?' interleaving with no
  // framing at all — live testing (conv150/conv166's re-probe) showed the model would
  // sometimes treat its own unframed prior "Assistant:" line as fabricated and explicitly
  // disclaim it to the user instead of trusting it as real history. This test now asserts the
  // fix's explicit history/current-message framing, not the old bug-shaped format.
  it('collects system messages into systemPrompt and frames prior turns as an explicit, labeled history block separate from the current message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'What time is it?' },
    ]
    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    expect(systemPrompt).toBe('You are helpful.')
    expect(prompt).toContain('--- Conversation so far ---')
    expect(prompt).toContain('User: Hi')
    expect(prompt).toContain('Assistant: Hello!')
    expect(prompt).toContain('--- End of conversation so far ---')
    expect(prompt.trim().endsWith("The user's current message:\nWhat time is it?")).toBe(true)
    // The current message must not itself be duplicated inside the history block.
    expect(prompt.indexOf('What time is it?')).toBe(prompt.lastIndexOf('What time is it?'))
  })

  it('falls back to a non-whitespace systemPrompt when there are no system messages, since the Anthropic API rejects a whitespace-only one', () => {
    const { systemPrompt } = buildClaudePrompt([{ role: 'user', content: 'Hi' }])
    expect(systemPrompt.trim()).not.toBe('')
  })
})

describe('parseClaudeCliOutput', () => {
  it('extracts the "result" field from --output-format json stdout', () => {
    expect(parseClaudeCliOutput('{"result": "hello there"}').reply).toBe('hello there')
  })

  it('falls back to "content" when "result" is absent', () => {
    expect(parseClaudeCliOutput('{"content": "fallback text"}').reply).toBe('fallback text')
  })

  it('falls back to raw trimmed stdout when it is not valid JSON', () => {
    const parsed = parseClaudeCliOutput('  plain text reply  \n')
    expect(parsed.reply).toBe('plain text reply')
    expect(parsed.usage).toBeUndefined()
  })

  it('parses usage and total_cost_usd when present', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({ result: 'hi', usage: { input_tokens: 312, output_tokens: 148 }, total_cost_usd: 0.0019 }),
    )
    expect(parsed.usage).toEqual({ inputTokens: 312, outputTokens: 148, costUsd: 0.0019 })
  })

  it('omits usage when the JSON has no usage field', () => {
    expect(parseClaudeCliOutput('{"result": "hi"}').usage).toBeUndefined()
  })

  it('omits usage when usage is present but incomplete (missing output_tokens)', () => {
    const parsed = parseClaudeCliOutput(JSON.stringify({ result: 'hi', usage: { input_tokens: 10 } }))
    expect(parsed.usage).toBeUndefined()
  })

  it('omits costUsd when total_cost_usd is absent even though usage is present', () => {
    const parsed = parseClaudeCliOutput(JSON.stringify({ result: 'hi', usage: { input_tokens: 10, output_tokens: 5 } }))
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
})

describe('stripJsonCodeFence', () => {
  it('strips a ```json ... ``` fence wrapping the whole reply', () => {
    expect(stripJsonCodeFence('```json\n{"tasks":[]}\n```')).toBe('{"tasks":[]}')
  })

  it('strips a bare ``` ... ``` fence with no "json" language tag', () => {
    expect(stripJsonCodeFence('```\n{"riskLevel":"LOW"}\n```')).toBe('{"riskLevel":"LOW"}')
  })

  it('leaves already-bare JSON untouched other than trimming', () => {
    expect(stripJsonCodeFence('  {"riskLevel":"LOW"}  ')).toBe('{"riskLevel":"LOW"}')
  })

  it('leaves prose with an embedded code fence untouched, since it does not wrap the whole reply', () => {
    const text = 'Here is an example:\n```js\nconsole.log(1)\n```\nThat is all.'
    expect(stripJsonCodeFence(text)).toBe(text)
  })
})
