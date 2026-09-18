import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, ToolDefinition, TokenUsage } from '@buildaharness/runtime'
import { sketchPlan } from './plan-sketch.js'

class FakeLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  receivedOptions: ChatOptions[] = []
  constructor(
    private readonly reply: string,
    private readonly throwError = false,
  ) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    this.calls++
    this.receivedMessages.push(messages)
    this.receivedOptions.push(options)
    if (this.throwError) throw new Error('boom')
    options.onUsage?.({ inputTokens: 10, outputTokens: 20 })
    return this.reply
  }

  async callChatStructured(): Promise<{ content: string; toolCalls?: never }> {
    throw new Error('sketchPlan must never call callChatStructured — it has no tools/staged output')
  }
}

describe('sketchPlan', () => {
  it('makes exactly one plain callChatSync call, no tools param, and returns the trimmed reply', async () => {
    const llm = new FakeLLMClient('  - Step one\n- Step two\n  ')
    const result = await sketchPlan(llm, 'Plan a launch', undefined, undefined, undefined)
    expect(llm.calls).toBe(1)
    expect(result).toEqual({ reply: '- Step one\n- Step two' })
  })

  it('folds grounding context in as an extra user message when supplied', async () => {
    const llm = new FakeLLMClient('sketch')
    await sketchPlan(llm, 'Plan a launch', '[read_file] found src/index.ts', undefined, undefined)
    const messages = llm.receivedMessages[0]
    expect(messages.some((m) => m.role === 'user' && m.content.includes('src/index.ts'))).toBe(true)
  })

  it('omits any grounding message when groundingContext is absent', async () => {
    const llm = new FakeLLMClient('sketch')
    await sketchPlan(llm, 'Plan a launch', undefined, undefined, undefined)
    const messages = llm.receivedMessages[0]
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('passes model and onUsage through to the LLM call', async () => {
    const llm = new FakeLLMClient('sketch')
    let usage: TokenUsage | undefined
    await sketchPlan(llm, 'Plan a launch', undefined, 'claude-x', (u) => {
      usage = u
    })
    expect(llm.receivedOptions[0].model).toBe('claude-x')
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('returns null on an empty reply, same "malformed output is the expected failure mode" fallback as draftPlanRevision', async () => {
    const llm = new FakeLLMClient('   ')
    expect(await sketchPlan(llm, 'Plan a launch', undefined, undefined, undefined)).toBeNull()
  })

  it('returns null instead of throwing when the LLM call itself throws', async () => {
    const llm = new FakeLLMClient('unused', true)
    expect(await sketchPlan(llm, 'Plan a launch', undefined, undefined, undefined)).toBeNull()
  })
})
