import { describe, it, expect, vi } from 'vitest'
import { transformExecutor } from './transform'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import type { ILLMClient } from '../llm-client'
import type { TransformNode } from '@itsharness/canvas'

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

function makeNode(overrides: Partial<TransformNode>): TransformNode {
  return { id: 'tx', type: 'transform', mode: 'mapping', ...overrides } as TransformNode
}

describe('TransformExecutor', () => {
  it('mode=fn_ref looks up key in FunctionRegistry and calls function with state', async () => {
    const fn = vi.fn().mockReturnValue({ transformed: 'yes' })
    const ctx = createExecutionContext({
      llmClient: mockLLMClient(),
      functions: new Map([['myFn', fn]]),
    })
    const result = await transformExecutor(makeNode({ mode: 'fn_ref', fn_ref: 'myFn' }), stateWith({ x: 1 }), ctx)
    expect(fn).toHaveBeenCalledWith({ x: 1 })
    expect(result.stateUpdate['transformed']).toBe('yes')
  })

  it('mode=mapping applies key remapping object to state fields', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const node = makeNode({ mode: 'mapping', mapping: [{ from: 'a', to: 'b' }] })
    const result = await transformExecutor(node, stateWith({ a: 'value' }), ctx)
    expect(result.stateUpdate['b']).toBe('value')
  })

  it('mode=fn_ref throws if fn_ref key not found in FunctionRegistry', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    await expect(
      transformExecutor(makeNode({ mode: 'fn_ref', fn_ref: 'missing' }), stateWith({}), ctx)
    ).rejects.toThrow()
  })
})
