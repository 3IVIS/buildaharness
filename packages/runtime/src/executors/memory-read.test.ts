import { describe, it, expect, vi } from 'vitest'
import { memoryReadExecutor } from './memory-read'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import { LLMClient } from '../llm-client'
import type { MemoryAdapter, MemoryResult } from '../memory/adapter'

function makeMockAdapter(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeContext(adapters: Map<string, MemoryAdapter> = new Map()) {
  const mockClient = { callChat: vi.fn(), callChatSync: vi.fn() } as unknown as LLMClient
  return createExecutionContext({ llmClient: mockClient, memoryAdapters: adapters })
}

const baseNode = {
  id: 'mem-read-1',
  type: 'memory_read' as const,
  label: 'Read',
  store_id: 'store1',
  output_key: 'result',
  position: { x: 0, y: 0 },
}

describe('MemoryReadExecutor', () => {
  it('key-value mode calls adapter.get with resolved key from key_expr', async () => {
    const adapter = makeMockAdapter({ get: vi.fn().mockResolvedValue('the-value') })
    const adapters = new Map([['store1', adapter]])
    const ctx = makeContext(adapters)
    const state = new FlowState()
    state.patch({ mykey: 'actual-key' })

    await memoryReadExecutor({ ...baseNode, retrieval_mode: 'key_value', key_expr: '{{mykey}}' }, state, ctx)
    expect(adapter.get).toHaveBeenCalledWith('actual-key')
  })

  it('key-value mode writes resolved value to state[output_key]', async () => {
    const adapter = makeMockAdapter({ get: vi.fn().mockResolvedValue('fetched-value') })
    const adapters = new Map([['store1', adapter]])
    const ctx = makeContext(adapters)
    const state = new FlowState()
    state.patch({ key: 'mykey' })

    const result = await memoryReadExecutor({ ...baseNode, retrieval_mode: 'key_value', key_expr: 'mykey' }, state, ctx)
    expect(result.stateUpdate['result']).toBe('fetched-value')
  })

  it('vector mode calls adapter.search with resolved query, top_k, and min_score', async () => {
    const hits: MemoryResult[] = [{ key: 'doc1', value: 'some text', score: 0.9 }]
    const adapter = makeMockAdapter({ search: vi.fn().mockResolvedValue(hits) })
    const adapters = new Map([['store1', adapter]])
    const ctx = makeContext(adapters)
    const state = new FlowState()
    state.patch({ question: 'what is AI?' })

    await memoryReadExecutor(
      { ...baseNode, retrieval_mode: 'semantic', query_expr: '{{question}}', top_k: 3, min_score: 0.7 },
      state,
      ctx,
    )
    expect(adapter.search).toHaveBeenCalledWith('what is AI?', 3, 0.7)
  })

  it('vector mode filters results below min_score before writing to output_key', async () => {
    const hits: MemoryResult[] = [
      { key: 'good', value: 'relevant', score: 0.9 },
      { key: 'bad', value: 'not relevant', score: 0.3 },
    ]
    const adapter = makeMockAdapter({ search: vi.fn().mockResolvedValue(hits) })
    const adapters = new Map([['store1', adapter]])
    const ctx = makeContext(adapters)
    const state = new FlowState()

    const out = await memoryReadExecutor(
      { ...baseNode, retrieval_mode: 'semantic', query_expr: 'query', top_k: 5, min_score: 0.7 },
      state,
      ctx,
    )
    const resultArr = out.stateUpdate['result'] as MemoryResult[]
    expect(resultArr).toHaveLength(1)
    expect(resultArr[0].key).toBe('good')
  })

  it('emits node:start then node:complete with resultCount in metadata', async () => {
    const hits: MemoryResult[] = [
      { key: 'a', value: 'x', score: 1.0 },
      { key: 'b', value: 'y', score: 1.0 },
    ]
    const adapter = makeMockAdapter({ search: vi.fn().mockResolvedValue(hits) })
    const adapters = new Map([['store1', adapter]])
    const events: string[] = []
    let completeMeta: Record<string, unknown> | undefined

    const mockClient = { callChat: vi.fn(), callChatSync: vi.fn() } as unknown as LLMClient
    const ctx = createExecutionContext({ llmClient: mockClient, memoryAdapters: adapters })
    ctx.eventBus.subscribe('node:start', () => events.push('start'))
    ctx.eventBus.subscribe('node:complete', (e) => {
      events.push('complete')
      completeMeta = e.metadata
    })

    const state = new FlowState()
    await memoryReadExecutor(
      { ...baseNode, retrieval_mode: 'semantic', query_expr: 'q', top_k: 5, min_score: 0.0 },
      state,
      ctx,
    )

    expect(events).toEqual(['start', 'complete'])
    expect(completeMeta?.resultCount).toBe(2)
  })

  it('missing store_id: emits node:error event and returns empty stateUpdate', async () => {
    const ctx = makeContext(new Map())
    const state = new FlowState()
    const errors: unknown[] = []
    ctx.eventBus.subscribe('node:error', (e) => errors.push(e.error))

    const out = await memoryReadExecutor({ ...baseNode, key_expr: 'k' }, state, ctx)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('store1')
    expect(out.stateUpdate).toEqual({})
  })
})
