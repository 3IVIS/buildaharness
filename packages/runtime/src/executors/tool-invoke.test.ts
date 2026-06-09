import { describe, it, expect, vi } from 'vitest'
import { toolInvokeExecutor } from './tool-invoke'
import { FlowState } from '../state'
import { createExecutionContext, ToolRegistry } from '../context'
import { LLMClient } from '../llm-client'
import { UnknownToolError } from '../errors'

function makeContext(registry?: ToolRegistry) {
  const mockClient = { callChat: vi.fn(), callChatSync: vi.fn() } as unknown as LLMClient
  return createExecutionContext({ llmClient: mockClient, toolRegistry: registry })
}

const baseNode = {
  id: 'tool-1',
  type: 'tool_invoke' as const,
  label: 'Invoke',
  tool_id: 'my-tool',
  position: { x: 0, y: 0 },
}

describe('ToolInvokeExecutor', () => {
  it('builds args from input_map via resolveValue and passes to tool', async () => {
    const execFn = vi.fn().mockResolvedValue({ result: 'ok' })
    const registry = new ToolRegistry()
    registry.register('my-tool', { name: 'my-tool', execute: execFn })
    const ctx = makeContext(registry)
    const state = new FlowState()
    state.patch({ question: 'what is 2+2?' })

    await toolInvokeExecutor(
      { ...baseNode, input_map: { q: '$.state.question' } },
      state,
      ctx,
    )
    expect(execFn).toHaveBeenCalledWith({ q: 'what is 2+2?' })
  })

  it('writes entire result to state[tool_id] when output_map not provided', async () => {
    const registry = new ToolRegistry()
    registry.register('my-tool', { name: 'my-tool', execute: vi.fn().mockResolvedValue('tool-result') })
    const ctx = makeContext(registry)
    const state = new FlowState()

    const out = await toolInvokeExecutor(baseNode, state, ctx)
    expect(out.stateUpdate['my-tool']).toBe('tool-result')
  })

  it('uses output_map to write specific fields to state keys', async () => {
    const registry = new ToolRegistry()
    registry.register('my-tool', {
      name: 'my-tool',
      execute: vi.fn().mockResolvedValue({ status: 200, body: { text: 'hello' } }),
    })
    const ctx = makeContext(registry)
    const state = new FlowState()

    const out = await toolInvokeExecutor(
      { ...baseNode, output_map: { statusCode: 'status', responseText: 'body.text' } },
      state,
      ctx,
    )
    expect(out.stateUpdate['statusCode']).toBe(200)
    expect(out.stateUpdate['responseText']).toBe('hello')
  })

  it('output_map with empty string path maps entire result to the state key', async () => {
    const registry = new ToolRegistry()
    registry.register('my-tool', { name: 'my-tool', execute: vi.fn().mockResolvedValue({ foo: 'bar' }) })
    const ctx = makeContext(registry)
    const state = new FlowState()

    const out = await toolInvokeExecutor(
      { ...baseNode, output_map: { allData: '' } },
      state,
      ctx,
    )
    expect(out.stateUpdate['allData']).toEqual({ foo: 'bar' })
  })

  it('throws UnknownToolError for unregistered tool_id', async () => {
    const ctx = makeContext(new ToolRegistry())
    const state = new FlowState()

    await expect(toolInvokeExecutor(baseNode, state, ctx)).rejects.toThrow(UnknownToolError)
  })

  it('emits node:start then node:complete with tool_id and durationMs', async () => {
    const registry = new ToolRegistry()
    registry.register('my-tool', { name: 'my-tool', execute: vi.fn().mockResolvedValue(null) })
    const ctx = makeContext(registry)
    const state = new FlowState()

    const events: string[] = []
    let completeMeta: Record<string, unknown> | undefined
    ctx.eventBus.subscribe('node:start', () => events.push('start'))
    ctx.eventBus.subscribe('node:complete', (e) => {
      events.push('complete')
      completeMeta = e.metadata
    })

    await toolInvokeExecutor(baseNode, state, ctx)
    expect(events).toEqual(['start', 'complete'])
    expect(completeMeta?.tool_id).toBe('my-tool')
    expect(typeof completeMeta?.durationMs).toBe('number')
  })

  it('built-in search tool is registered by default and returns empty array', async () => {
    const ctx = makeContext()
    const state = new FlowState()

    const out = await toolInvokeExecutor(
      { ...baseNode, tool_id: 'search', output_map: { results: '' } },
      state,
      ctx,
    )
    expect(out.stateUpdate['results']).toEqual([])
  })
})
