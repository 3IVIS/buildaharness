import { describe, it, expect, vi } from 'vitest'
import { memoryReadExecutor } from './memory-read'
import { FlowState } from '../state'
import { EventBus } from '../events'
import { createExecutionContext } from '../context'
import { LLMClient } from '../llm-client'
import type { MemoryAdapter, MemoryResult } from '../memory/adapter'
import { InMemoryAdapter } from '../memory/in-memory'

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

  // T6: regression guard for scoring.ts's tokenized/graduated scorer (see scoring.ts, scoring.test.ts).
  // These run through a real InMemoryAdapter — not a mocked search() — so they exercise the actual
  // scoreEntries() pipeline a FlowSpec author's semantic memory_read node depends on, not just the
  // executor's own filtering logic around a stubbed result.
  describe('semantic mode against the real scorer (T6 regression guard)', () => {
    it('an exact-substring query that scored 1.0 under the old scorer still ranks first and still passes min_score: 1.0', async () => {
      const adapter = new InMemoryAdapter()
      await adapter.set('doc1', 'the dentist appointment is on friday')
      await adapter.set('doc2', 'appointment for the dentist next week')
      const adapters = new Map<string, MemoryAdapter>([['store1', adapter]])
      const ctx = makeContext(adapters)
      const state = new FlowState()
      state.patch({ question: 'dentist appointment' })

      const out = await memoryReadExecutor(
        {
          ...baseNode,
          retrieval_mode: 'semantic',
          query_expr: '{{question}}',
          top_k: 5,
          min_score: 1.0,
        },
        state,
        ctx,
      )
      const resultArr = out.stateUpdate['result'] as MemoryResult[]
      // doc1 contains "dentist appointment" verbatim (exact substring) -> score 1.0, passes the filter.
      // doc2 has the same tokens reordered -> scores below 1.0, filtered out by min_score: 1.0.
      expect(resultArr).toHaveLength(1)
      expect(resultArr[0].key).toBe('doc1')
      expect(resultArr[0].score).toBe(1.0)
    })

    it('a fractional min_score now behaves as a real graduated threshold, not silently-equivalent-to-1.0 dead configuration', async () => {
      const adapter = new InMemoryAdapter()
      // Exact substring match -> scores 1.0.
      await adapter.set('exact', 'dentist appointment reminder')
      // Same tokens, different order -> scores below 1.0 but above the 0.5 threshold (2/2 terms matched, capped at 0.95).
      await adapter.set('reordered', 'appointment for the dentist')
      // Only one of the two query terms present -> scores below 0.5, filtered out.
      await adapter.set('partial', 'dentist visit only, no mention of the other word')
      // No overlap at all -> scores 0, filtered out.
      await adapter.set('unrelated', 'completely different content about groceries')
      const adapters = new Map<string, MemoryAdapter>([['store1', adapter]])
      const ctx = makeContext(adapters)
      const state = new FlowState()
      state.patch({ question: 'dentist appointment' })

      const out = await memoryReadExecutor(
        {
          ...baseNode,
          retrieval_mode: 'semantic',
          query_expr: '{{question}}',
          top_k: 5,
          min_score: 0.5,
        },
        state,
        ctx,
      )
      const resultArr = out.stateUpdate['result'] as MemoryResult[]
      const keys = resultArr.map((r) => r.key)
      expect(keys).toEqual(['exact', 'reordered'])
      expect(resultArr[0].score).toBe(1.0)
      expect(resultArr[1].score).toBeGreaterThanOrEqual(0.5)
      expect(resultArr[1].score).toBeLessThan(1.0)
    })
  })
})
