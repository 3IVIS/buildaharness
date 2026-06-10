import { describe, it, expect, vi } from 'vitest'
import { parallelForkExecutor } from './parallel-fork'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import type { ILLMClient } from '../llm-client'
import type { ParallelForkNode } from '@itsharness/canvas'

function mockLLMClient(): ILLMClient {
  return {
    callChat: vi.fn().mockImplementation(async function* () {}),
    callChatSync: vi.fn().mockResolvedValue(''),
    callChatStructured: vi.fn().mockResolvedValue({ content: '' }),
  }
}

function makeContext(eventBus?: EventBus) {
  return createExecutionContext({ llmClient: mockLLMClient(), eventBus })
}

function makeForkNode(overrides: Partial<ParallelForkNode> = {}): ParallelForkNode {
  return {
    id: 'fork1',
    type: 'parallel_fork',
    targets: ['branch-a', 'branch-b'],
    ...overrides,
  }
}

describe('ParallelForkExecutor', () => {
  it('emits node:start then node:complete in order', async () => {
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe('node:start', () => events.push('start'))
    bus.subscribe('node:complete', () => events.push('complete'))
    const ctx = makeContext(bus)
    const state = new FlowState()

    await parallelForkExecutor(makeForkNode(), state, ctx)

    expect(events).toEqual(['start', 'complete'])
  })

  it('node:start event carries correct nodeId and nodeType', async () => {
    const startEvents: { nodeId: string; nodeType: string }[] = []
    const bus = new EventBus()
    bus.subscribe('node:start', e => startEvents.push({ nodeId: e.nodeId, nodeType: e.nodeType }))
    const ctx = makeContext(bus)
    const state = new FlowState()

    await parallelForkExecutor(makeForkNode({ id: 'my-fork' }), state, ctx)

    expect(startEvents[0]).toEqual({ nodeId: 'my-fork', nodeType: 'parallel_fork' })
  })

  it('node:complete event carries correct nodeId and nodeType', async () => {
    const completeEvents: { nodeId: string; nodeType: string; durationMs: number }[] = []
    const bus = new EventBus()
    bus.subscribe('node:complete', e =>
      completeEvents.push({ nodeId: e.nodeId, nodeType: e.nodeType, durationMs: e.durationMs })
    )
    const ctx = makeContext(bus)
    const state = new FlowState()

    await parallelForkExecutor(makeForkNode({ id: 'my-fork' }), state, ctx)

    expect(completeEvents[0].nodeId).toBe('my-fork')
    expect(completeEvents[0].nodeType).toBe('parallel_fork')
    expect(typeof completeEvents[0].durationMs).toBe('number')
  })

  it('returns empty stateUpdate', async () => {
    const ctx = makeContext()
    const state = new FlowState()

    const result = await parallelForkExecutor(makeForkNode(), state, ctx)

    expect(result.stateUpdate).toEqual({})
  })

  it('does not set routeToNodeId (FlowRuntime controls routing)', async () => {
    const ctx = makeContext()
    const state = new FlowState()

    const result = await parallelForkExecutor(makeForkNode(), state, ctx)

    expect(result.routeToNodeId).toBeUndefined()
  })

  it('does not modify the passed FlowState', async () => {
    const ctx = makeContext()
    const state = new FlowState()
    state.patch({ existingKey: 'existingValue' })

    await parallelForkExecutor(makeForkNode(), state, ctx)

    expect(state.get('existingKey')).toBe('existingValue')
  })
})
