import { describe, it, expect, vi } from 'vitest'
import { llmCallExecutor } from './llm-call'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import type { ILLMClient, ChatMessage, ChatOptions } from '../llm-client'
import type { LlmCallNode } from '@buildaharness/canvas'

function mockLLMClient(tokens: string[]): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) {
      for (const t of tokens) yield t
    },
    async callChatSync(_msgs: ChatMessage[], _opts?: ChatOptions) {
      return tokens.join('')
    },
    async callChatStructured() {
      return { content: tokens.join('') }
    },
  }
}

function stateWith(data: Record<string, unknown>): FlowState {
  const s = new FlowState()
  for (const [k, v] of Object.entries(data)) s.set(k, v)
  return s
}

function makeNode(overrides: Partial<LlmCallNode> = {}): LlmCallNode {
  return {
    id: 'llm1',
    type: 'llm_call',
    prompt_template: 'Say hello',
    output_key: 'result',
    ...overrides,
  }
}

describe('LLMCallExecutor', () => {
  it('system_prompt included as system role message in messages array', async () => {
    const captured: { role: string; content: string }[] = []
    const client: ILLMClient = {
      async *callChat(msgs) {
        captured.push(...msgs)
        yield 'ok'
      },
      callChatSync: vi.fn().mockResolvedValue('ok'),
      callChatStructured: vi.fn().mockResolvedValue({ content: 'ok' }),
    }
    const ctx = createExecutionContext({ llmClient: client })
    await llmCallExecutor(makeNode({ system_prompt: 'You are helpful' }), stateWith({}), ctx)
    expect(captured[0]).toEqual({ role: 'system', content: 'You are helpful' })
  })

  it('prompt_template resolved against FlowState before messages built', async () => {
    const captured: { role: string; content: string }[] = []
    const client: ILLMClient = {
      async *callChat(msgs) {
        captured.push(...msgs)
        yield 'answer'
      },
      callChatSync: vi.fn().mockResolvedValue('answer'),
      callChatStructured: vi.fn().mockResolvedValue({ content: 'answer' }),
    }
    const ctx = createExecutionContext({ llmClient: client })
    const state = stateWith({ topic: 'TypeScript' })
    await llmCallExecutor(makeNode({ prompt_template: 'Tell me about {{topic}}' }), state, ctx)
    const userMsg = captured.find(m => m.role === 'user')
    expect(userMsg?.content).toBe('Tell me about TypeScript')
  })

  it('structured_output.schema parses valid JSON response into object', async () => {
    const json = JSON.stringify({ severity: 'high', reason: 'spam' })
    const ctx = createExecutionContext({ llmClient: mockLLMClient([json]) })
    const node = makeNode({
      structured_output: { schema: { type: 'object', properties: { severity: { type: 'string' } } } },
    })
    const result = await llmCallExecutor(node, stateWith({}), ctx)
    expect(result.stateUpdate['result']).toEqual({ severity: 'high', reason: 'spam' })
  })

  it('structured_output.schema throws on response that fails schema validation', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient(['not json']) })
    const node = makeNode({
      structured_output: { schema: { type: 'object', properties: { severity: { type: 'string' } } } },
    })
    await expect(llmCallExecutor(node, stateWith({}), ctx)).rejects.toThrow()
  })

  it('streaming mode emits TokenChunk events then NodeComplete', async () => {
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe('token:chunk', e => events.push(`chunk:${e.token}`))
    bus.subscribe('node:complete', () => events.push('complete'))
    const ctx = createExecutionContext({ llmClient: mockLLMClient(['hello', ' world']), eventBus: bus })
    await llmCallExecutor(makeNode(), stateWith({}), ctx)
    expect(events).toContain('chunk:hello')
    expect(events).toContain('chunk: world')
    expect(events[events.length - 1]).toBe('complete')
  })

  it('non-streaming mode returns full concatenated string', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient(['foo', 'bar']) })
    const result = await llmCallExecutor(makeNode({ output_key: 'answer' }), stateWith({}), ctx)
    expect(result.stateUpdate['answer']).toBe('foobar')
  })

  it('result written to state[output_key]', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient(['response text']) })
    const result = await llmCallExecutor(makeNode({ output_key: 'my_key' }), stateWith({}), ctx)
    expect(result.stateUpdate['my_key']).toBe('response text')
  })
})
