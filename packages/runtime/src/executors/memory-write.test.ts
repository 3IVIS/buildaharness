import { describe, it, expect, vi } from 'vitest'
import { memoryWriteExecutor } from './memory-write'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import { LLMClient } from '../llm-client'
import type { MemoryAdapter } from '../memory/adapter'

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
  id: 'mem-write-1',
  type: 'memory_write' as const,
  label: 'Write',
  store_id: 'store1',
  key_expr: '{{mykey}}',
  value_expr: '$.state.myval',
  position: { x: 0, y: 0 },
}

describe('MemoryWriteExecutor', () => {
  it('upsert mode calls adapter.set with resolved key and value', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'the-key', myval: { data: 42 } })

    await memoryWriteExecutor({ ...baseNode, write_mode: 'upsert' }, state, ctx)
    expect(adapter.set).toHaveBeenCalledWith('the-key', { data: 42 }, 'upsert')
  })

  it('overwrite mode calls adapter.set with overwrite mode', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'k', myval: 'new-value' })

    await memoryWriteExecutor({ ...baseNode, write_mode: 'overwrite' }, state, ctx)
    expect(adapter.set).toHaveBeenCalledWith('k', 'new-value', 'overwrite')
  })

  it('defaults to upsert when write_mode not specified', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'k', myval: 'v' })

    const node = { ...baseNode }
    // @ts-expect-error — testing default when write_mode is omitted
    delete node.write_mode
    await memoryWriteExecutor(node, state, ctx)
    expect(adapter.set).toHaveBeenCalledWith('k', 'v', 'upsert')
  })

  it('value_expr with $.state.path resolves to the actual typed value (not a string)', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'key', myval: [1, 2, 3] })

    await memoryWriteExecutor(baseNode, state, ctx)
    const [, writtenValue] = (adapter.set as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.isArray(writtenValue)).toBe(true)
    expect(writtenValue).toEqual([1, 2, 3])
  })

  it('emits node:start then node:complete', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'k', myval: 'v' })

    const events: string[] = []
    ctx.eventBus.subscribe('node:start', () => events.push('start'))
    ctx.eventBus.subscribe('node:complete', () => events.push('complete'))

    await memoryWriteExecutor(baseNode, state, ctx)
    expect(events).toEqual(['start', 'complete'])
  })

  it('returns empty stateUpdate', async () => {
    const adapter = makeMockAdapter()
    const ctx = makeContext(new Map([['store1', adapter]]))
    const state = new FlowState()
    state.patch({ mykey: 'k', myval: 'v' })

    const out = await memoryWriteExecutor(baseNode, state, ctx)
    expect(out.stateUpdate).toEqual({})
  })

  it('missing store_id: emits node:error and returns empty stateUpdate', async () => {
    const ctx = makeContext(new Map())
    const state = new FlowState()
    state.patch({ mykey: 'k', myval: 'v' })
    const errors: unknown[] = []
    ctx.eventBus.subscribe('node:error', (e) => errors.push(e.error))

    const out = await memoryWriteExecutor(baseNode, state, ctx)
    expect(errors).toHaveLength(1)
    expect(out.stateUpdate).toEqual({})
  })
})
