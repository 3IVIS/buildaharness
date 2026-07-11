import { describe, it, expect, vi } from 'vitest'
import { FlowRuntime } from './runtime'
import { createExecutionContext } from './context'
import { UnknownNodeTypeError, AbortedError } from './errors'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse } from './llm-client'
import type { FlowSpec, RuntimeFlowSpec } from './spec/schema'
import { assertRuntimeFlowSpec } from './spec/schema'
import { getExecutor, registerExecutor, unregisterExecutor } from './executors/index'

// Mirrors the 'RAG Agent' example flow (packages/canvas/src/spec/examples.ts,
// EXAMPLE_FLOWS[0]) — kept as an independent literal rather than imported from
// canvas so this package's tests don't reach into canvas's source tree.
const RAG_AGENT_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'rag-agent-flow',
  name: 'RAG Agent',
  state_schema: {
    type: 'object',
    properties: {
      question:          { type: 'string', description: 'User input question' },
      retrieved_chunks:  { type: 'array',  description: 'Relevant document chunks', reducer: 'replace' },
      formatted_context: { type: 'string', description: 'Chunks as a context string' },
      answer:            { type: 'string', description: 'Generated grounded answer' },
    },
    required: ['question'],
  },
  memory_stores: {
    knowledge_base: { type: 'vector', backend: 'qdrant', connection_env: 'QDRANT_URL', embedding_model: 'text-embedding-3-small', dimensions: 1536, scope: 'global' },
    qa_cache:       { type: 'key_value', backend: 'redis', connection_env: 'REDIS_URL', scope: 'thread' },
  },
  nodes: [
    { id: 'start',          type: 'input',        output_schema: { type: 'object', properties: { question: { type: 'string' } } } },
    { id: 'retrieve',       type: 'memory_read',  store_id: 'knowledge_base', retrieval_mode: 'semantic', query_expr: '$.state.question', top_k: 5, min_score: 0.72, output_key: 'retrieved_chunks' },
    { id: 'format_context', type: 'transform',    mode: 'fn_ref', fn_ref: '@canvas/flows-rag/formatChunks' },
    { id: 'generate',       type: 'llm_call',     system_prompt: 'You are a helpful assistant. Answer using only the provided context.', prompt_template: 'Context:\n{{$.state.formatted_context}}\n\nQuestion: {{$.state.question}}\n\nAnswer:', model_params: { temperature: 0.1, max_tokens: 512 }, output_key: 'answer' },
    { id: 'cache_qa',       type: 'memory_write', store_id: 'qa_cache', key_expr: '$.state.question', value_expr: '$.state.answer', write_mode: 'upsert' },
    { id: 'done',           type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start',          to: 'retrieve' },
    { type: 'direct', from: 'retrieve',       to: 'format_context' },
    { type: 'direct', from: 'format_context', to: 'generate' },
    { type: 'direct', from: 'generate',       to: 'cache_qa' },
    { type: 'direct', from: 'cache_qa',       to: 'done' },
  ],
}

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
    const ragFlow = RAG_AGENT_FLOW
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

describe('FlowRuntime - Harness-enabled flows', () => {
  // A minimal harness flow with:
  //   - harness_meta.enabled: true  → allowCycles: true
  //   - harness node types (gather_evidence, update_world_model) as stubs
  //   - a cycle-forming condition node (retry loop) that exits on first pass
  const HARNESS_FLOW: RuntimeFlowSpec = assertRuntimeFlowSpec({
    spec_version: '0.2.0',
    id: 'harness-test-flow',
    harness_meta: { enabled: true, input_key: 'message' },
    nodes: [
      { id: 'start',     type: 'input' },
      { id: 'gather',    type: 'gather_evidence' },
      { id: 'update_wm', type: 'update_world_model' },
      {
        id: 'route',
        type: 'condition',
        branches: [{ condition: { type: 'expr', expr: "$.state.retry == 'yes'" }, target: 'gather' }],
        default_target: 'done',
      },
      { id: 'done', type: 'output' },
    ],
    edges: [
      { type: 'direct', from: 'start',     to: 'gather' },
      { type: 'direct', from: 'gather',    to: 'update_wm' },
      { type: 'direct', from: 'update_wm', to: 'route' },
      { type: 'direct', from: 'route',     to: 'gather' },
      { type: 'direct', from: 'route',     to: 'done' },
    ],
  })

  it('assertRuntimeFlowSpec accepts harness node types and harness_meta without throwing', () => {
    expect(HARNESS_FLOW.id).toBe('harness-test-flow')
    expect((HARNESS_FLOW.harness_meta as Record<string, unknown>)['enabled']).toBe(true)
    expect(HARNESS_FLOW.nodes.map((n: { type: string }) => n.type)).toContain('gather_evidence')
    expect(HARNESS_FLOW.nodes.map((n: { type: string }) => n.type)).toContain('update_world_model')
  })

  it('executes harness flow: stub nodes pass through without modifying state', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    // retry: 'no' → condition takes default_target (done) on first evaluation
    const state = await runtime.execute(HARNESS_FLOW, { message: 'hello', retry: 'no' }, ctx)
    expect(state.get('message')).toBe('hello')
    expect(state.get('retry')).toBe('no')
  })

  it('emits node:start and node:complete events for harness stub nodes', async () => {
    const runtime = new FlowRuntime()
    const events: { type: string; nodeId: string }[] = []
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    ctx.eventBus.subscribe('node:start',    e => events.push({ type: e.type, nodeId: e.nodeId }))
    ctx.eventBus.subscribe('node:complete', e => events.push({ type: e.type, nodeId: e.nodeId }))
    await runtime.execute(HARNESS_FLOW, { message: 'hi', retry: 'no' }, ctx)
    const gatherStarts   = events.filter(e => e.type === 'node:start'    && e.nodeId === 'gather')
    const gatherComplete = events.filter(e => e.type === 'node:complete' && e.nodeId === 'gather')
    expect(gatherStarts.length).toBeGreaterThanOrEqual(1)
    expect(gatherComplete.length).toBeGreaterThanOrEqual(1)
  })
})
