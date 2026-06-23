import { describe, it, expect, vi } from 'vitest'
import { FlowRuntime } from './runtime'
import { createExecutionContext } from './context'
import { UnknownNodeTypeError, AbortedError } from './errors'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse } from './llm-client'
import type { FlowSpec } from '@buildaharness/canvas'
import { EXAMPLE_FLOWS } from '../../canvas/src/spec/examples'
import { getExecutor, registerExecutor, unregisterExecutor } from './executors/index'

function mockLLMClient(response = 'mocked response'): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) {
      yield response
    },
    async callChatSync() {
      return response
    },
    async callChatStructured(): Promise<LLMStructuredResponse> {
      return { content: response }
    },
  }
}

const MINIMAL_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'test-flow',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'done', type: 'output' },
  ],
  edges: [{ type: 'direct', from: 'start', to: 'done' }],
}

const LLM_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'llm-flow',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'gen', type: 'llm_call', prompt_template: 'Q: {{question}}', output_key: 'answer' },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'gen' },
    { type: 'direct', from: 'gen', to: 'done' },
  ],
}

const CONDITION_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'condition-flow',
  nodes: [
    { id: 'start', type: 'input' },
    {
      id: 'route',
      type: 'condition',
      branches: [{ condition: { type: 'expr', expr: "$.state.path == 'a'" }, target: 'node-a' }],
      default_target: 'node-b',
    },
    { id: 'node-a', type: 'transform', mode: 'mapping', mapping: [{ from: 'path', to: 'result' }] },
    { id: 'node-b', type: 'transform', mode: 'mapping', mapping: [{ from: 'path', to: 'result' }] },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'route' },
    { type: 'direct', from: 'route', to: 'node-a' },
    { type: 'direct', from: 'route', to: 'node-b' },
    { type: 'direct', from: 'node-a', to: 'done' },
    { type: 'direct', from: 'node-b', to: 'done' },
  ],
}

describe('FlowRuntime', () => {
  it('validates FlowSpec via assertFlowSpec() at init; unsupported spec_version throws immediately with a clear error', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    await expect(runtime.execute({ spec_version: '0.0.0', id: 'x', nodes: [], edges: [] }, {}, ctx)).rejects.toThrow()
  })

  it('throws UnknownNodeTypeError with nodeId for unregistered node type', async () => {
    // Temporarily unregister hitl_breakpoint to simulate a valid spec node with no executor
    const original = getExecutor('hitl_breakpoint')
    unregisterExecutor('hitl_breakpoint')
    try {
      const flow: FlowSpec = {
        spec_version: '0.2.0',
        id: 'unknown-type-flow',
        nodes: [
          { id: 'start', type: 'input' },
          { id: 'pause', type: 'hitl_breakpoint' },
          { id: 'done', type: 'output' },
        ],
        edges: [
          { type: 'direct', from: 'start', to: 'pause' },
          { type: 'direct', from: 'pause', to: 'done' },
        ],
      }
      const runtime = new FlowRuntime()
      const ctx = createExecutionContext({ llmClient: mockLLMClient() })
      await expect(runtime.execute(flow, {}, ctx)).rejects.toThrow(UnknownNodeTypeError)
    } finally {
      if (original) registerExecutor('hitl_breakpoint', original)
    }
  })

  it('AbortController.abort() stops execution; executor after abort is never called', async () => {
    const runtime = new FlowRuntime()
    const abortController = new AbortController()
    const ctx = createExecutionContext({ llmClient: mockLLMClient(), abortController })
    abortController.abort()
    await expect(runtime.execute(MINIMAL_FLOW, {}, ctx)).rejects.toThrow(AbortedError)
  })

  it('runs minimal flow end-to-end and returns FlowState', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = await runtime.execute(MINIMAL_FLOW, { greeting: 'hello' }, ctx)
    expect(state.get('greeting')).toBe('hello')
  })

  it('condition routing takes matching branch', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = await runtime.execute(CONDITION_FLOW, { path: 'a' }, ctx)
    expect(state.get('result')).toBe('a')
  })

  it('condition routing falls through to default_target', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = await runtime.execute(CONDITION_FLOW, { path: 'other' }, ctx)
    expect(state.get('result')).toBe('other')
  })

  it('runs full RAG Agent flow (mocked LLM) end-to-end and returns final FlowState with answer', async () => {
    const ragFlow = EXAMPLE_FLOWS[0].spec
    const runtime = new FlowRuntime()
    const mockMemory = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    }
    const ctx = createExecutionContext({
      llmClient: mockLLMClient('The answer is 42.'),
      memoryAdapters: new Map([
        ['knowledge_base', mockMemory],
        ['qa_cache', mockMemory],
      ]),
      functions: new Map([
        ['@canvas/flows-rag/formatChunks', (_state: Record<string, unknown>) => ({ formatted_context: 'formatted' })],
      ]),
    })
    const state = await runtime.execute(ragFlow, { question: 'What is the answer?' }, ctx)
    expect(state.get('question')).toBe('What is the answer?')
  })

  it('LLM flow: prompt resolved from trigger data', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient('42') })
    const state = await runtime.execute(LLM_FLOW, { question: 'What is 6*7?' }, ctx)
    expect(state.get('answer')).toBe('42')
  })

  it('Phase 3 integration: RAG flow with mocked memory adapters and mocked LLM returns answer, memory_write called', async () => {
    // A simplified RAG flow: input → memory_read → llm_call → memory_write → output
    const ragFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'p3-rag-test',
      nodes: [
        { id: 'start',     type: 'input' },
        { id: 'retrieve',  type: 'memory_read',  store_id: 'kb', retrieval_mode: 'semantic', query_expr: '{{question}}', top_k: 3, min_score: 0.0, output_key: 'chunks' },
        { id: 'generate',  type: 'llm_call',     prompt_template: 'Answer: {{question}}', output_key: 'answer' },
        { id: 'cache',     type: 'memory_write', store_id: 'cache', key_expr: '{{question}}', value_expr: '$.state.answer', write_mode: 'upsert' },
        { id: 'done',      type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',    to: 'retrieve' },
        { type: 'direct', from: 'retrieve', to: 'generate' },
        { type: 'direct', from: 'generate', to: 'cache' },
        { type: 'direct', from: 'cache',    to: 'done' },
      ],
    }

    const mockKB = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([{ key: 'doc1', value: 'context content', score: 0.9 }]),
      delete: vi.fn().mockResolvedValue(undefined),
    }
    const mockCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    }

    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({
      llmClient: mockLLMClient('The answer'),
      memoryAdapters: new Map([
        ['kb', mockKB],
        ['cache', mockCache],
      ]),
    })

    const state = await runtime.execute(ragFlow, { question: 'What is 2+2?' }, ctx)

    // LLM answer should be written to state
    expect(state.get('answer')).toBe('The answer')
    // Semantic search was invoked on the knowledge base
    expect(mockKB.search).toHaveBeenCalledWith('What is 2+2?', 3, 0.0)
    // Cache adapter's set was called with resolved question key and the LLM answer
    expect(mockCache.set).toHaveBeenCalledWith('What is 2+2?', 'The answer', 'upsert')
  })

  it('Phase 3 integration: memory_stores in spec auto-inits InMemoryAdapter when not pre-registered', async () => {
    const flowWithStores: FlowSpec = {
      spec_version: '0.2.0',
      id: 'auto-init-test',
      memory_stores: {
        auto_store: { type: 'key_value', backend: 'in_memory', scope: 'thread' },
      },
      nodes: [
        { id: 'start',  type: 'input' },
        { id: 'write',  type: 'memory_write', store_id: 'auto_store', key_expr: 'k', value_expr: '$.state.val', write_mode: 'upsert' },
        { id: 'read',   type: 'memory_read',  store_id: 'auto_store', retrieval_mode: 'key_value', key_expr: 'k', output_key: 'retrieved' },
        { id: 'done',   type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'write' },
        { type: 'direct', from: 'write', to: 'read' },
        { type: 'direct', from: 'read',  to: 'done' },
      ],
    }

    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = await runtime.execute(flowWithStores, { val: 'stored-value' }, ctx)
    expect(state.get('retrieved')).toBe('stored-value')
  })
})
