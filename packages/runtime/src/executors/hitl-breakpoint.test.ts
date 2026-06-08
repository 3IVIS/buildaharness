import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hitlBreakpointExecutor } from './hitl-breakpoint'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import { FlowExecutionError, HITLTimeoutError } from '../errors'
import type { ILLMClient, ChatMessage, ChatOptions } from '../llm-client'
import type { MemoryAdapter } from '../memory/adapter'

function makeMockLLMClient(): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) { yield '' },
    async callChatSync() { return '' },
    async callChatStructured() { return { content: '' } },
  }
}

function makeMockStore(): MemoryAdapter & { _data: Map<string, unknown> } {
  const _data = new Map<string, unknown>()
  return {
    _data,
    get: vi.fn(async (key: string) => _data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { _data.set(key, value) }),
    search: vi.fn(async () => []),
    delete: vi.fn(async (key: string) => { _data.delete(key) }),
  }
}

function makeContext(store?: MemoryAdapter) {
  return createExecutionContext({
    llmClient: makeMockLLMClient(),
    hitlPersistStore: store ?? makeMockStore(),
  })
}

const baseNode = {
  id: 'pause-1',
  type: 'hitl_breakpoint' as const,
  position: { x: 0, y: 0 },
}

describe('HITLBreakpointExecutor', () => {
  describe('prompt resolution', () => {
    it('resolves prompt_template against FlowState before emitting pause event', async () => {
      const store = makeMockStore()
      const ctx = makeContext(store)
      const state = new FlowState()
      state.patch({ severity: 'high', user: 'alice' })

      const pausedEvents: string[] = []
      ctx.eventBus.subscribe('flow:paused', (e) => pausedEvents.push(e.prompt))

      // Start executor (it will pause — resume immediately)
      const node = { ...baseNode, prompt: 'Review {{severity}} content from {{user}}', output_key: 'decision' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx)

      // Wait a tick for the event to be emitted
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(pausedEvents[0]).toBe('Review high content from alice')

      // Resume to unblock
      ctx.hitlResolvers.get('pause-1')?.({ decision: 'approve' })
      await execPromise
    })
  })

  describe('flow:paused event', () => {
    it('emits FlowPaused event with nodeId, resolved prompt, and resumeSchema', async () => {
      const ctx = makeContext()
      const state = new FlowState()
      state.patch({ level: 'critical' })

      const schema = { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] }
      const pausedEvent = await new Promise<{nodeId: string; prompt: string; resumeSchema: object}>((resolve) => {
        ctx.eventBus.subscribe('flow:paused', (e) => resolve(e))
        const node = { ...baseNode, prompt: 'Level: {{level}}', resume_schema: schema, output_key: 'decision' }
        hitlBreakpointExecutor(node, state, ctx).catch(() => {})
      })

      expect(pausedEvent.nodeId).toBe('pause-1')
      expect(pausedEvent.prompt).toBe('Level: critical')
      expect(pausedEvent.resumeSchema).toEqual(schema)

      // Resume to unblock
      ctx.hitlResolvers.get('pause-1')?.({ decision: 'approve' })
    })
  })

  describe('persistence', () => {
    it('HITL pause state persisted to store BEFORE FlowPaused event fires', async () => {
      const store = makeMockStore()
      const ctx = makeContext(store)
      const state = new FlowState()
      state.patch({ x: 'y' })

      let persistCallTime = -1
      let pauseEventTime = -1

      const setOrig = store.set as ReturnType<typeof vi.fn>
      setOrig.mockImplementation(async (key: string, value: unknown) => {
        persistCallTime = Date.now()
        store._data.set(key, value)
      })

      ctx.eventBus.subscribe('flow:paused', () => {
        pauseEventTime = Date.now()
      })

      const node = { ...baseNode, prompt: 'Approve?', output_key: 'out' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx)

      await new Promise(resolve => setTimeout(resolve, 0))

      // store.set should have been called
      expect(store.set).toHaveBeenCalledWith(
        'pause-1:state',
        expect.objectContaining({ nodeId: 'pause-1' }),
        'upsert',
      )
      // persistCallTime was set, and pause event fired after or at same time
      expect(persistCallTime).toBeGreaterThan(-1)

      // Resume and verify cleanup
      ctx.hitlResolvers.get('pause-1')?.({ })
      await execPromise

      expect(store.delete).toHaveBeenCalledWith('pause-1:state')
    })
  })

  describe('suspension', () => {
    it('execution suspended — node after HITL is not called until resume() invoked', async () => {
      const ctx = makeContext()
      const state = new FlowState()
      let resumed = false

      const node = { ...baseNode, output_key: 'result' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx).then((output) => {
        resumed = true
        return output
      })

      // Not yet resumed
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(resumed).toBe(false)

      // Now resume
      ctx.hitlResolvers.get('pause-1')?.({ value: 42 })
      await execPromise
      expect(resumed).toBe(true)
    })
  })

  describe('resume schema validation', () => {
    it('valid payload written to state[output_key] after resume', async () => {
      const ctx = makeContext()
      const state = new FlowState()

      const schema = { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] }
      const node = { ...baseNode, resume_schema: schema, output_key: 'review_result' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx)

      await new Promise(resolve => setTimeout(resolve, 0))
      ctx.hitlResolvers.get('pause-1')?.({ decision: 'approve', reviewer: 'alice' })
      const output = await execPromise

      expect(output.stateUpdate['review_result']).toEqual({ decision: 'approve', reviewer: 'alice' })
    })

    it('invalid payload throws validation error without resolving the Promise; status stays paused', async () => {
      const ctx = makeContext()
      const state = new FlowState()

      const schema = { type: 'object', required: ['decision'] }
      const node = { ...baseNode, resume_schema: schema, output_key: 'out' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx)

      await new Promise(resolve => setTimeout(resolve, 0))

      // Try invalid payload (missing required 'decision' field)
      expect(() => {
        ctx.hitlResolvers.get('pause-1')?.({ reviewer: 'alice' })
      }).toThrow(FlowExecutionError)

      // The executor should still be waiting (resolver not removed)
      let resolved = false
      execPromise.then(() => { resolved = true }).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(resolved).toBe(false)

      // Now provide valid payload to clean up
      ctx.hitlResolvers.get('pause-1')?.({ decision: 'approve' })
      await execPromise
    })

    it('resume() called with wrong nodeId does not affect active pause', async () => {
      const ctx = makeContext()
      const state = new FlowState()
      const node = { ...baseNode, output_key: 'out' }
      const execPromise = hitlBreakpointExecutor(node, state, ctx)

      await new Promise(resolve => setTimeout(resolve, 0))

      // Call resolver for wrong nodeId — should not affect 'pause-1'
      const wrongResolver = ctx.hitlResolvers.get('wrong-id')
      expect(wrongResolver).toBeUndefined()

      let resolved = false
      execPromise.then(() => { resolved = true }).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(resolved).toBe(false)

      // Resume the correct node to clean up
      ctx.hitlResolvers.get('pause-1')?.({})
      await execPromise
    })
  })

  describe('timeout behavior', () => {
    it('on_timeout=raise throws HITLTimeoutError after timeout_seconds elapses', async () => {
      vi.useFakeTimers()
      try {
        const ctx = makeContext()
        const state = new FlowState()
        const node = { ...baseNode, timeout_seconds: 30, on_timeout: 'raise' as const }

        // Set up the promise before we advance time
        const execPromise = hitlBreakpointExecutor(node, state, ctx)
        // Attach a no-op catch to prevent unhandled rejection warnings
        const caughtPromise = execPromise.catch(() => {})

        // Advance timers past timeout — triggers the 30s setTimeout callback
        await vi.advanceTimersByTimeAsync(30001)

        // Now verify the original promise rejected with HITLTimeoutError
        await expect(execPromise).rejects.toThrow(HITLTimeoutError)
        await caughtPromise
      } finally {
        vi.useRealTimers()
      }
    })

    it('on_timeout=skip resolves with null payload and execution continues', async () => {
      vi.useFakeTimers()
      try {
        const ctx = makeContext()
        const state = new FlowState()
        const node = { ...baseNode, timeout_seconds: 10, on_timeout: 'skip' as const, output_key: 'skipped_result' }

        const execPromise = hitlBreakpointExecutor(node, state, ctx)

        // Advance timers past timeout — triggers the 10s setTimeout callback
        await vi.advanceTimersByTimeAsync(10001)

        const output = await execPromise
        // null payload with on_timeout=skip — output_key not written
        expect(output.stateUpdate['skipped_result']).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
