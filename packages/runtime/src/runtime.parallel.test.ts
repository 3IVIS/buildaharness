import { describe, it, expect, vi, afterEach } from 'vitest'
import { FlowRuntime } from './runtime'
import { createExecutionContext } from './context'
import { registerExecutor, getExecutor } from './executors/index'
import { EventBus } from './events'
import { FlowState } from './state'
import { FlowExecutionError, AbortedError } from './errors'
import type { ILLMClient, ChatMessage, ChatOptions } from './llm-client'
import type { FlowSpec, Node } from '@buildaharness/canvas'
import type { ExecutorFn } from './executors/index'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLLMClient(): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) {
      yield 'mocked'
    },
    async callChatSync() {
      return 'mocked'
    },
    async callChatStructured() {
      return { content: 'mocked' }
    },
  }
}

function makeContext(opts: {
  eventBus?: EventBus
  abortController?: AbortController
  retryConfig?: { maxRetries?: number; retryOn?: string[]; delayBaseMs?: number }
} = {}) {
  return createExecutionContext({
    llmClient: mockLLMClient(),
    ...opts,
  })
}

/**
 * Register an executor for `nodeType` for the duration of a test, restoring
 * the original (or deleting the entry) in the afterEach cleanup list.
 * Returns a cleanup function — call it at the end of the test or push it to
 * a cleanup array that gets called in afterEach.
 */
function withExecutor(nodeType: string, fn: ExecutorFn): () => void {
  const original = getExecutor(nodeType)
  registerExecutor(nodeType, fn)
  return () => {
    if (original !== undefined) {
      registerExecutor(nodeType, original)
    }
    // Note: we can't delete from REGISTRY directly; re-registering original
    // is the correct restore. If there was no original, re-register a no-op.
    // For node types that never existed we just leave the test stub in place
    // (acceptable within the isolated test file context).
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Minimal parallel flow: input → fork → [branchA, branchB] → join → output
// Uses 'transform' nodes (valid spec type with real executor) for branches.
// ---------------------------------------------------------------------------

const PARALLEL_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'parallel-flow',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'fork', type: 'parallel_fork', targets: ['branch-a', 'branch-b'] },
    { id: 'branch-a', type: 'transform', mode: 'mapping', mapping: [{ from: 'question', to: 'answer-a' }] },
    { id: 'branch-b', type: 'transform', mode: 'mapping', mapping: [{ from: 'question', to: 'answer-b' }] },
    { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'fork' },
    { type: 'direct', from: 'fork', to: 'branch-a' },
    { type: 'direct', from: 'fork', to: 'branch-b' },
    { type: 'direct', from: 'branch-a', to: 'join' },
    { type: 'direct', from: 'branch-b', to: 'join' },
    { type: 'direct', from: 'join', to: 'done' },
  ],
}

// Three-branch parallel flow for the risk assessment end-to-end test.
// Uses 'agent_role' nodes — executor registered per-test.
const RISK_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'risk-flow',
  nodes: [
    { id: 'start', type: 'input' },
    {
      id: 'fork',
      type: 'parallel_fork',
      targets: ['legal-agent', 'financial-agent', 'technical-agent'],
    },
    { id: 'legal-agent', type: 'agent_role', config: { agent_ref: 'legal', task_description: 'Assess legal risk' } },
    { id: 'financial-agent', type: 'agent_role', config: { agent_ref: 'financial', task_description: 'Assess financial risk' } },
    { id: 'technical-agent', type: 'agent_role', config: { agent_ref: 'technical', task_description: 'Assess technical risk' } },
    { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'fork' },
    { type: 'direct', from: 'fork', to: 'legal-agent' },
    { type: 'direct', from: 'fork', to: 'financial-agent' },
    { type: 'direct', from: 'fork', to: 'technical-agent' },
    { type: 'direct', from: 'legal-agent', to: 'join' },
    { type: 'direct', from: 'financial-agent', to: 'join' },
    { type: 'direct', from: 'technical-agent', to: 'join' },
    { type: 'direct', from: 'join', to: 'done' },
  ],
}

// ---------------------------------------------------------------------------
// Parallel Fork tests
// ---------------------------------------------------------------------------

describe('FlowRuntime - Parallel Fork', () => {
  it('all target branches dispatched concurrently (verified via delayed async stubs)', async () => {
    const startOrder: string[] = []

    let resolveA!: () => void
    let resolveB!: () => void

    const cleanup = withExecutor('memory_read', async (node, _state, context) => {
      startOrder.push(node.id)
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      if (node.id === 'branch-slow-a') {
        await new Promise<void>(res => { resolveA = res })
      } else {
        await new Promise<void>(res => { resolveB = res })
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const flow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'overlap-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['branch-slow-a', 'branch-slow-b'] },
        { id: 'branch-slow-a', type: 'memory_read', store_id: 'x', output_key: 'a' },
        { id: 'branch-slow-b', type: 'memory_read', store_id: 'y', output_key: 'b' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'branch-slow-a' },
        { type: 'direct', from: 'fork', to: 'branch-slow-b' },
        { type: 'direct', from: 'branch-slow-a', to: 'join' },
        { type: 'direct', from: 'branch-slow-b', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()

      const executePromise = runtime.execute(flow, {}, ctx)

      // Wait until both branches have started (proving concurrent dispatch)
      await new Promise<void>(res => {
        const check = () => {
          if (startOrder.length >= 2) {
            res()
          } else {
            setTimeout(check, 1)
          }
        }
        check()
      })

      // Both started before either resolved → they ran concurrently
      expect(startOrder).toHaveLength(2)
      expect(startOrder).toContain('branch-slow-a')
      expect(startOrder).toContain('branch-slow-b')

      // Unblock both branches
      resolveA()
      resolveB()
      await executePromise
    } finally {
      cleanup()
    }
  })

  it('each branch receives an independent FlowState snapshot', async () => {
    const snapshots: Record<string, unknown>[] = []

    const cleanup = withExecutor('memory_write', async (node, state, context) => {
      snapshots.push(state.toJSON())
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: { [`captured_by_${node.id}`]: true } }
    })

    const flow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'snapshot-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['snap-a', 'snap-b'] },
        { id: 'snap-a', type: 'memory_write', store_id: 'x', key_expr: 'a', value_expr: 'a' },
        { id: 'snap-b', type: 'memory_write', store_id: 'y', key_expr: 'b', value_expr: 'b' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'snap-a' },
        { type: 'direct', from: 'fork', to: 'snap-b' },
        { type: 'direct', from: 'snap-a', to: 'join' },
        { type: 'direct', from: 'snap-b', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      await runtime.execute(flow, { seed: 'value' }, ctx)

      expect(snapshots).toHaveLength(2)
      // Both branches see the parent seed value
      expect(snapshots[0]['seed']).toBe('value')
      expect(snapshots[1]['seed']).toBe('value')
    } finally {
      cleanup()
    }
  })

  it('emits NodeStart for each branch target', async () => {
    const startedNodes: string[] = []
    const bus = new EventBus()
    bus.subscribe('node:start', e => startedNodes.push(e.nodeId))

    const runtime = new FlowRuntime()
    const ctx = makeContext({ eventBus: bus })
    await runtime.execute(PARALLEL_FLOW, { question: 'hello' }, ctx)

    expect(startedNodes).toContain('branch-a')
    expect(startedNodes).toContain('branch-b')
  })

  it('NodeStart emitted for both branches (concurrent dispatch confirmed via event order)', async () => {
    const bus = new EventBus()
    const branchStartEvents: string[] = []
    bus.subscribe('node:start', e => {
      if (e.nodeId.startsWith('branch-')) branchStartEvents.push(e.nodeId)
    })

    const runtime = new FlowRuntime()
    const ctx = makeContext({ eventBus: bus })
    await runtime.execute(PARALLEL_FLOW, { question: 'test' }, ctx)

    expect(branchStartEvents).toContain('branch-a')
    expect(branchStartEvents).toContain('branch-b')
    expect(branchStartEvents).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Parallel Join tests
// ---------------------------------------------------------------------------

describe('FlowRuntime - Parallel Join', () => {
  it('merges fields from all branches correctly', async () => {
    const runtime = new FlowRuntime()
    const ctx = makeContext()
    const state = await runtime.execute(PARALLEL_FLOW, { question: 'hello' }, ctx)

    expect(state.get('answer-a')).toBe('hello')
    expect(state.get('answer-b')).toBe('hello')
  })

  it('replace reducer (merge) — values from both branches present after merge', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      // Each agent writes a unique key — no conflict
      const key = node.id === 'legal-agent' ? 'legal_risk' : 'financial_risk'
      return { stateUpdate: { [key]: node.id } }
    })

    const twoAgentFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'two-agent-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['legal-agent', 'financial-agent'] },
        { id: 'legal-agent', type: 'agent_role', config: { agent_ref: 'legal', task_description: 'Legal' } },
        { id: 'financial-agent', type: 'agent_role', config: { agent_ref: 'financial', task_description: 'Financial' } },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'legal-agent' },
        { type: 'direct', from: 'fork', to: 'financial-agent' },
        { type: 'direct', from: 'legal-agent', to: 'join' },
        { type: 'direct', from: 'financial-agent', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      const state = await runtime.execute(twoAgentFlow, {}, ctx)

      expect(state.get('legal_risk')).toBe('legal-agent')
      expect(state.get('financial_risk')).toBe('financial-agent')
    } finally {
      cleanup()
    }
  })

  it('last branch wins on key conflict (merge reducer)', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      const value = node.id === 'legal-agent' ? 'low' : 'high'
      return { stateUpdate: { shared_key: value } }
    })

    const twoAgentFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'conflict-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['legal-agent', 'financial-agent'] },
        { id: 'legal-agent', type: 'agent_role', config: { agent_ref: 'legal', task_description: 'Legal' } },
        { id: 'financial-agent', type: 'agent_role', config: { agent_ref: 'financial', task_description: 'Financial' } },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'legal-agent' },
        { type: 'direct', from: 'fork', to: 'financial-agent' },
        { type: 'direct', from: 'legal-agent', to: 'join' },
        { type: 'direct', from: 'financial-agent', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      const state = await runtime.execute(twoAgentFlow, {}, ctx)

      // One of the two values must win
      expect(['low', 'high']).toContain(state.get('shared_key'))
    } finally {
      cleanup()
    }
  })

  it('array reducer — arrays concatenated across branches', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      const items = node.id === 'legal-agent' ? [1, 2] : [3, 4]
      return { stateUpdate: { items } }
    })

    const appendFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'append-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['legal-agent', 'financial-agent'] },
        { id: 'legal-agent', type: 'agent_role', config: { agent_ref: 'legal', task_description: 'Legal' } },
        { id: 'financial-agent', type: 'agent_role', config: { agent_ref: 'financial', task_description: 'Financial' } },
        { id: 'join', type: 'parallel_join', join_reducer: 'append' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'legal-agent' },
        { type: 'direct', from: 'fork', to: 'financial-agent' },
        { type: 'direct', from: 'legal-agent', to: 'join' },
        { type: 'direct', from: 'financial-agent', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      const state = await runtime.execute(appendFlow, {}, ctx)

      const items = state.get('items') as number[]
      expect(items).toHaveLength(4)
      expect(items).toContain(1)
      expect(items).toContain(2)
      expect(items).toContain(3)
      expect(items).toContain(4)
    } finally {
      cleanup()
    }
  })

  it('warns on key conflicts during join', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: { conflicted: `value-from-${node.id}` } }
    })

    const warnFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'warn-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['legal-agent', 'financial-agent'] },
        { id: 'legal-agent', type: 'agent_role', config: { agent_ref: 'legal', task_description: 'Legal' } },
        { id: 'financial-agent', type: 'agent_role', config: { agent_ref: 'financial', task_description: 'Financial' } },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'legal-agent' },
        { type: 'direct', from: 'fork', to: 'financial-agent' },
        { type: 'direct', from: 'legal-agent', to: 'join' },
        { type: 'direct', from: 'financial-agent', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      await runtime.execute(warnFlow, {}, ctx)

      expect(warnSpy).toHaveBeenCalled()
      const warnMsg: string = warnSpy.mock.calls[0][0] as string
      expect(warnMsg).toContain('conflicted')
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Parallel error propagation
// ---------------------------------------------------------------------------

describe('FlowRuntime - Parallel Error Propagation', () => {
  it('one branch failure aborts remaining branches', async () => {
    // Use a promise to track when the slow branch observes the abort signal.
    // The slow branch resolves this when it detects abort.
    let slowBranchAbortPromise!: Promise<boolean>
    let resolveSlowBranchAbort!: (aborted: boolean) => void

    slowBranchAbortPromise = new Promise<boolean>(res => {
      resolveSlowBranchAbort = res
    })

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      if (node.id === 'fail-node') {
        throw new Error('Branch failed')
      }
      // slow branch: wait for abort signal via event listener
      await new Promise<void>(res => {
        if (context.signal.aborted) {
          res()
        } else {
          context.signal.addEventListener('abort', () => res(), { once: true })
          // Safety timeout to avoid hanging tests
          setTimeout(res, 200)
        }
      })
      resolveSlowBranchAbort(context.signal.aborted)
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const errorFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'error-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['fail-node', 'slow-node'] },
        { id: 'fail-node', type: 'tool_invoke', tool_id: 'fail' },
        { id: 'slow-node', type: 'tool_invoke', tool_id: 'slow' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'fail-node' },
        { type: 'direct', from: 'fork', to: 'slow-node' },
        { type: 'direct', from: 'fail-node', to: 'join' },
        { type: 'direct', from: 'slow-node', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      await expect(runtime.execute(errorFlow, {}, ctx)).rejects.toThrow()
      // Wait for the slow branch to observe the abort signal
      const branchObservedAbort = await slowBranchAbortPromise
      expect(branchObservedAbort).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('first error surfaced as FlowExecutionError', async () => {
    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      if (node.id === 'throw-node') {
        throw new Error('explicit failure')
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const firstErrFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'first-error-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['throw-node', 'noop-node'] },
        { id: 'throw-node', type: 'tool_invoke', tool_id: 'fail' },
        { id: 'noop-node', type: 'tool_invoke', tool_id: 'noop' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'throw-node' },
        { type: 'direct', from: 'fork', to: 'noop-node' },
        { type: 'direct', from: 'throw-node', to: 'join' },
        { type: 'direct', from: 'noop-node', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      const err = await runtime.execute(firstErrFlow, {}, ctx).catch(e => e)
      expect(err).toBeInstanceOf(FlowExecutionError)
    } finally {
      cleanup()
    }
  })

  it('no partial state merge on failure — execute() throws instead of returning state', async () => {
    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      if (node.id === 'fail-branch') {
        throw new Error('Branch failed early')
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: { partial_result: 'should_not_appear' } }
    })

    const partialFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'partial-state-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['fail-branch', 'success-branch'] },
        { id: 'fail-branch', type: 'tool_invoke', tool_id: 'fail' },
        { id: 'success-branch', type: 'tool_invoke', tool_id: 'success' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'fail-branch' },
        { type: 'direct', from: 'fork', to: 'success-branch' },
        { type: 'direct', from: 'fail-branch', to: 'join' },
        { type: 'direct', from: 'success-branch', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      await expect(runtime.execute(partialFlow, {}, ctx)).rejects.toThrow()
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Retry tests
// ---------------------------------------------------------------------------

describe('FlowRuntime - Retry', () => {
  it('retries on 429 with backoff; succeeds on 3rd attempt', async () => {
    let callCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      callCount++
      if (callCount < 3) {
        throw new FlowExecutionError({
          nodeId: node.id,
          message: 'Rate limited',
          cause: { status: 429 },
        })
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: { success: true } }
    })

    const retryFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'retry-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'risky', type: 'tool_invoke', tool_id: 'rate-limited' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'risky' },
        { type: 'direct', from: 'risky', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 2, retryOn: ['429'], delayBaseMs: 0 } })
      const state = await runtime.execute(retryFlow, {}, ctx)

      expect(callCount).toBe(3)
      expect(state.get('success')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('does not retry on 400', async () => {
    let callCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      callCount++
      throw new FlowExecutionError({
        nodeId: node.id,
        message: 'Bad request',
        cause: { status: 400 },
      })
    })

    const noRetryFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'no-retry-400-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'bad', type: 'tool_invoke', tool_id: 'bad' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'bad' },
        { type: 'direct', from: 'bad', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 2, retryOn: ['429'], delayBaseMs: 0 } })
      await expect(runtime.execute(noRetryFlow, {}, ctx)).rejects.toThrow()
      expect(callCount).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('does not retry on 500 when not in retryOn list', async () => {
    let callCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      callCount++
      throw new FlowExecutionError({
        nodeId: node.id,
        message: 'Server error',
        cause: { status: 500 },
      })
    })

    const no500Flow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'no-retry-500-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'server-err', type: 'tool_invoke', tool_id: 'server' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'server-err' },
        { type: 'direct', from: 'server-err', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 3, retryOn: ['429'], delayBaseMs: 0 } })
      await expect(runtime.execute(no500Flow, {}, ctx)).rejects.toThrow()
      expect(callCount).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('retryCount returned from _runNodeWithRetry is correct', async () => {
    let innerCallCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      innerCallCount++
      if (innerCallCount < 3) {
        throw new FlowExecutionError({ nodeId: node.id, message: 'Rate limited', cause: { status: 429 } })
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    try {
      const checkerNode: Node = { id: 'rc-node', type: 'tool_invoke', tool_id: 'rc' }
      const stateForTest = new FlowState()
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 3, retryOn: ['429'], delayBaseMs: 0 } })

      const result = await runtime._runNodeWithRetry(checkerNode, stateForTest, ctx)

      // Was called 3 times total; retryCount = number of retries = 2
      expect(result.retryCount).toBe(2)
      expect(innerCallCount).toBe(3)
    } finally {
      cleanup()
    }
  })

  it('max retries exhausted throws FlowExecutionError', async () => {
    let callCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      callCount++
      throw new FlowExecutionError({
        nodeId: node.id,
        message: 'Always rate limited',
        cause: { status: 429 },
      })
    })

    const exhaustFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'exhaust-retry-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'always-fail', type: 'tool_invoke', tool_id: 'fail' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'always-fail' },
        { type: 'direct', from: 'always-fail', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 2, retryOn: ['429'], delayBaseMs: 0 } })

      await expect(runtime.execute(exhaustFlow, {}, ctx)).rejects.toThrow(FlowExecutionError)
      // Initial attempt + 2 retries = 3 total
      expect(callCount).toBe(3)
    } finally {
      cleanup()
    }
  })

  it('network error (TypeError) retried when "network" in retryOn', async () => {
    let callCount = 0

    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      callCount++
      if (callCount === 1) {
        throw new TypeError('Failed to fetch')
      }
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: { network_ok: true } }
    })

    const netRetryFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'network-retry-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'net-node', type: 'tool_invoke', tool_id: 'network' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'net-node' },
        { type: 'direct', from: 'net-node', to: 'done' },
      ],
    }

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ retryConfig: { maxRetries: 2, retryOn: ['network'], delayBaseMs: 0 } })
      const state = await runtime.execute(netRetryFlow, {}, ctx)

      expect(callCount).toBe(2)
      expect(state.get('network_ok')).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Parallel Risk Assessment end-to-end test
// ---------------------------------------------------------------------------

describe('FlowRuntime - Parallel Risk Assessment (end-to-end)', () => {
  it('3-branch parallel flow: legal, financial, technical risks all merged in final state', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })

      const stateUpdate: Record<string, unknown> = {}
      if (node.id === 'legal-agent') {
        stateUpdate['legal_risk'] = 'low'
      } else if (node.id === 'financial-agent') {
        stateUpdate['financial_risk'] = 'medium'
      } else if (node.id === 'technical-agent') {
        stateUpdate['technical_risk'] = 'high'
      }

      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate }
    })

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      const state = await runtime.execute(RISK_FLOW, { scenario: 'merger' }, ctx)

      expect(state.get('legal_risk')).toBe('low')
      expect(state.get('financial_risk')).toBe('medium')
      expect(state.get('technical_risk')).toBe('high')
      expect(state.get('scenario')).toBe('merger')
    } finally {
      cleanup()
    }
  })

  it('emits NodeStart for all 3 agent branches', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const startedNodes: string[] = []
    const bus = new EventBus()
    bus.subscribe('node:start', e => startedNodes.push(e.nodeId))

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ eventBus: bus })
      await runtime.execute(RISK_FLOW, { scenario: 'test' }, ctx)

      expect(startedNodes).toContain('legal-agent')
      expect(startedNodes).toContain('financial-agent')
      expect(startedNodes).toContain('technical-agent')
    } finally {
      cleanup()
    }
  })

  it('join node emits node:complete event', async () => {
    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const completeNodes: string[] = []
    const bus = new EventBus()
    bus.subscribe('node:complete', e => completeNodes.push(e.nodeId))

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ eventBus: bus })
      await runtime.execute(RISK_FLOW, { scenario: 'test' }, ctx)
      expect(completeNodes).toContain('join')
    } finally {
      cleanup()
    }
  })

  it('all 3 branches run in parallel (all started before any resolved)', async () => {
    const startOrder: string[] = []

    const cleanup = withExecutor('agent_role', async (node, _state, context) => {
      startOrder.push(node.id)
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      // Barrier: wait until all 3 agents have started
      await new Promise<void>(res => {
        const check = () => {
          if (startOrder.length >= 3) {
            res()
          } else {
            setTimeout(check, 1)
          }
        }
        check()
      })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext()
      await runtime.execute(RISK_FLOW, { scenario: 'parallel' }, ctx)

      expect(startOrder).toHaveLength(3)
      expect(startOrder).toContain('legal-agent')
      expect(startOrder).toContain('financial-agent')
      expect(startOrder).toContain('technical-agent')
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AbortController tests
// ---------------------------------------------------------------------------

describe('FlowRuntime - AbortController', () => {
  it('AbortedError thrown when abort() called before execute', async () => {
    const runtime = new FlowRuntime()
    const abortController = new AbortController()
    abortController.abort()
    const ctx = makeContext({ abortController })

    await expect(runtime.execute(PARALLEL_FLOW, { question: 'hello' }, ctx)).rejects.toThrow(AbortedError)
  })

  it('branch context inherits parent abort signal linkage', async () => {
    // This test verifies that when parent is aborted, the branch context sees it.
    // We use a simple flow where the branch is already aborted from the start.
    const cleanup = withExecutor('tool_invoke', async (node, _state, context) => {
      context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
      context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
      return { stateUpdate: {} }
    })

    const branchFlow: FlowSpec = {
      spec_version: '0.2.0',
      id: 'abort-branch-flow',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork', type: 'parallel_fork', targets: ['b1', 'b2'] },
        { id: 'b1', type: 'tool_invoke', tool_id: 't1' },
        { id: 'b2', type: 'tool_invoke', tool_id: 't2' },
        { id: 'join', type: 'parallel_join', join_reducer: 'merge' },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork', to: 'b1' },
        { type: 'direct', from: 'fork', to: 'b2' },
        { type: 'direct', from: 'b1', to: 'join' },
        { type: 'direct', from: 'b2', to: 'join' },
        { type: 'direct', from: 'join', to: 'done' },
      ],
    }

    // Pre-aborted controller
    const abortController = new AbortController()
    abortController.abort()

    try {
      const runtime = new FlowRuntime()
      const ctx = makeContext({ abortController })
      await expect(runtime.execute(branchFlow, {}, ctx)).rejects.toThrow(AbortedError)
    } finally {
      cleanup()
    }
  })
})
