import { describe, it, expect, vi } from 'vitest'
import { outputExecutor } from './output'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import type { ILLMClient } from '../llm-client'
import type { OutputNode } from '@itsharness/canvas'

function mockLLMClient(): ILLMClient {
  return {
    callChat: vi.fn().mockImplementation(async function* () {}),
    callChatSync: vi.fn().mockResolvedValue(''),
    callChatStructured: vi.fn().mockResolvedValue({ content: '' }),
  }
}

function stateWith(data: Record<string, unknown>): FlowState {
  const s = new FlowState()
  for (const [k, v] of Object.entries(data)) s.set(k, v)
  return s
}

function makeNode(overrides: Partial<OutputNode> = {}): OutputNode {
  return { id: 'done', type: 'output', ...overrides }
}

describe('OutputExecutor', () => {
  it('emits FlowComplete with final FlowState payload', async () => {
    let finalState: Record<string, unknown> | undefined
    const bus = new EventBus()
    bus.subscribe('flow:complete', e => { finalState = e.finalState })
    const ctx = createExecutionContext({ llmClient: mockLLMClient(), eventBus: bus })
    await outputExecutor(makeNode(), stateWith({ answer: 'done' }), ctx)
    expect(finalState?.['answer']).toBe('done')
  })

  it('emits warning event (not error) on output_schema validation mismatch', async () => {
    const errors: string[] = []
    const bus = new EventBus()
    bus.subscribe('node:error', () => errors.push('error'))
    const ctx = createExecutionContext({ llmClient: mockLLMClient(), eventBus: bus })
    const node = makeNode({
      input_schema: {
        type: 'object',
        properties: { required_field: { type: 'string' } },
        required: ['required_field'],
      } as Record<string, unknown>,
    })
    // State missing required_field — should emit warning via node:error but not throw
    await expect(outputExecutor(node, stateWith({ other: 'x' }), ctx)).resolves.toBeDefined()
    expect(errors).toHaveLength(1)
  })
})
