import { describe, it, expect, vi, afterEach } from 'vitest'
import { parallelJoinExecutor } from './parallel-join'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import type { ILLMClient } from '../llm-client'
import type { ParallelJoinNode } from '@itsharness/canvas'

function mockLLMClient(): ILLMClient {
  return {
    callChat: vi.fn().mockImplementation(async function* () {}),
    callChatSync: vi.fn().mockResolvedValue(''),
    callChatStructured: vi.fn().mockResolvedValue({ content: '' }),
  }
}

function makeContext(eventBus?: EventBus, branchResults?: Map<string, FlowState[]>) {
  const ctx = createExecutionContext({ llmClient: mockLLMClient(), eventBus })
  if (branchResults) {
    // Populate the branchResults map on the shared context
    for (const [k, v] of branchResults) {
      ctx.branchResults.set(k, v)
    }
  }
  return ctx
}

function makeJoinNode(overrides: Partial<ParallelJoinNode> = {}): ParallelJoinNode {
  return {
    id: 'join1',
    type: 'parallel_join',
    join_reducer: 'merge',
    ...overrides,
  }
}

function makeState(data: Record<string, unknown>): FlowState {
  const s = new FlowState()
  s.patch(data)
  return s
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ParallelJoinExecutor', () => {
  describe('merge reducer', () => {
    it('distinct keys from different branches all appear in output', async () => {
      const branchA = makeState({ legal_risk: 'low' })
      const branchB = makeState({ financial_risk: 'medium' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['legal_risk']).toBe('low')
      expect(result.stateUpdate['financial_risk']).toBe('medium')
    })

    it('last branch wins on key conflict', async () => {
      const branchA = makeState({ risk: 'low' })
      const branchB = makeState({ risk: 'high' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      // Branch B is processed second, so its value wins
      expect(result.stateUpdate['risk']).toBe('high')
    })

    it('fn_ref treated as merge — last branch wins on conflict', async () => {
      const branchA = makeState({ score: 10 })
      const branchB = makeState({ score: 20 })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'fn_ref' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['score']).toBe(20)
    })

    it('returns empty stateUpdate when no branch results exist', async () => {
      const ctx = makeContext()
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate).toEqual({})
    })
  })

  describe('append reducer', () => {
    it('arrays from different branches concatenated', async () => {
      const branchA = makeState({ items: [1, 2] })
      const branchB = makeState({ items: [3, 4] })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'append' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['items']).toEqual([1, 2, 3, 4])
    })

    it('non-array values use last-write-wins', async () => {
      const branchA = makeState({ name: 'Alice' })
      const branchB = makeState({ name: 'Bob' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'append' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['name']).toBe('Bob')
    })

    it('mixed: existing array + new scalar appended as element', async () => {
      const branchA = makeState({ tags: ['a', 'b'] })
      const branchB = makeState({ tags: 'c' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'append' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['tags']).toEqual(['a', 'b', 'c'])
    })

    it('mixed: existing scalar + new array — scalar prepended to array', async () => {
      const branchA = makeState({ tags: 'a' })
      const branchB = makeState({ tags: ['b', 'c'] })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'append' })
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['tags']).toEqual(['a', 'b', 'c'])
    })
  })

  describe('key conflict warning', () => {
    it('warns on key conflicts via console.warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const branchA = makeState({ risk: 'low' })
      const branchB = makeState({ risk: 'high' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy.mock.calls[0][0]).toContain('key conflict')
      expect(warnSpy.mock.calls[0][0]).toContain('risk')
    })

    it('does not warn when no key conflicts', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const branchA = makeState({ legal_risk: 'low' })
      const branchB = makeState({ financial_risk: 'medium' })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('warns once per conflicted key', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const branchA = makeState({ risk: 'low', score: 10 })
      const branchB = makeState({ risk: 'high', score: 20 })
      const branchResults = new Map([['join1', [branchA, branchB]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode({ join_reducer: 'merge' })
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      // Two conflicts: 'risk' and 'score'
      expect(warnSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('lifecycle events', () => {
    it('emits node:start then node:complete in order', async () => {
      const events: string[] = []
      const bus = new EventBus()
      bus.subscribe('node:start', () => events.push('start'))
      bus.subscribe('node:complete', () => events.push('complete'))
      const ctx = makeContext(bus)
      const node = makeJoinNode()
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      expect(events).toEqual(['start', 'complete'])
    })

    it('node:start carries correct nodeId and nodeType', async () => {
      const startEvents: { nodeId: string; nodeType: string }[] = []
      const bus = new EventBus()
      bus.subscribe('node:start', e => startEvents.push({ nodeId: e.nodeId, nodeType: e.nodeType }))
      const ctx = makeContext(bus)
      const node = makeJoinNode({ id: 'my-join' })
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      expect(startEvents[0]).toEqual({ nodeId: 'my-join', nodeType: 'parallel_join' })
    })

    it('node:complete carries durationMs as a number', async () => {
      const completeEvents: { durationMs: number }[] = []
      const bus = new EventBus()
      bus.subscribe('node:complete', e => completeEvents.push({ durationMs: e.durationMs }))
      const ctx = makeContext(bus)
      const node = makeJoinNode()
      const state = makeState({})

      await parallelJoinExecutor(node, state, ctx)

      expect(typeof completeEvents[0].durationMs).toBe('number')
    })
  })

  describe('internal state key filtering', () => {
    it('does not include __triggerData__ in merged output', async () => {
      const branchA = makeState({ __triggerData__: { question: 'q' }, result: 'ok' })
      const branchResults = new Map([['join1', [branchA]]])

      const ctx = makeContext(undefined, branchResults)
      const node = makeJoinNode()
      const state = makeState({})

      const result = await parallelJoinExecutor(node, state, ctx)

      expect(result.stateUpdate['__triggerData__']).toBeUndefined()
      expect(result.stateUpdate['result']).toBe('ok')
    })
  })
})
