import { describe, it, expect, vi } from 'vitest'
import { EventBus } from './events'
import type { RuntimeEvent, NodeStartEvent, TokenChunkEvent, FlowCompleteEvent } from './events'

describe('EventBus', () => {
  describe('subscribe and emit', () => {
    it('calls the handler when a matching event is emitted', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      bus.subscribe('node:start', handler)

      const event: NodeStartEvent = { type: 'node:start', nodeId: 'n1', nodeType: 'llm' }
      bus.emit(event)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(event)
    })

    it('does not call handler for a different event type', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      bus.subscribe('node:start', handler)

      const event: TokenChunkEvent = { type: 'token:chunk', nodeId: 'n1', token: 'hello' }
      bus.emit(event)

      expect(handler).not.toHaveBeenCalled()
    })

    it('calls multiple handlers for the same event type', () => {
      const bus = new EventBus()
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      bus.subscribe('token:chunk', handler1)
      bus.subscribe('token:chunk', handler2)

      const event: TokenChunkEvent = { type: 'token:chunk', nodeId: 'n1', token: 'world' }
      bus.emit(event)

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('handles emitting with no subscribers', () => {
      const bus = new EventBus()
      // Should not throw
      expect(() => {
        bus.emit({ type: 'flow:complete', finalState: {} })
      }).not.toThrow()
    })
  })

  describe('unsubscribe', () => {
    it('stops receiving events after unsubscribing', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      const unsubscribe = bus.subscribe('node:start', handler)

      const event: NodeStartEvent = { type: 'node:start', nodeId: 'n1', nodeType: 'llm' }
      bus.emit(event)
      expect(handler).toHaveBeenCalledOnce()

      unsubscribe()
      bus.emit(event)
      // Still only called once after unsubscribe
      expect(handler).toHaveBeenCalledOnce()
    })

    it('only unsubscribes the specific handler', () => {
      const bus = new EventBus()
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const unsubscribe1 = bus.subscribe('node:start', handler1)
      bus.subscribe('node:start', handler2)

      const event: NodeStartEvent = { type: 'node:start', nodeId: 'n1', nodeType: 'llm' }
      unsubscribe1()
      bus.emit(event)

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('calling unsubscribe multiple times does not throw', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      const unsubscribe = bus.subscribe('node:start', handler)

      expect(() => {
        unsubscribe()
        unsubscribe()
      }).not.toThrow()
    })
  })

  describe('multiple event types', () => {
    it('correctly routes different event types to respective handlers', () => {
      const bus = new EventBus()
      const startHandler = vi.fn()
      const tokenHandler = vi.fn()
      const completeHandler = vi.fn()

      bus.subscribe('node:start', startHandler)
      bus.subscribe('token:chunk', tokenHandler)
      bus.subscribe('flow:complete', completeHandler)

      bus.emit({ type: 'node:start', nodeId: 'n1', nodeType: 'llm' })
      bus.emit({ type: 'token:chunk', nodeId: 'n1', token: 'hello' })
      bus.emit({ type: 'flow:complete', finalState: { result: 'done' } })

      expect(startHandler).toHaveBeenCalledOnce()
      expect(tokenHandler).toHaveBeenCalledOnce()
      expect(completeHandler).toHaveBeenCalledOnce()
    })

    it('passes the correct event payload to each handler', () => {
      const bus = new EventBus()
      const completeHandler = vi.fn()
      bus.subscribe('flow:complete', completeHandler)

      const finalState = { output: 'test', count: 42 }
      const event: FlowCompleteEvent = { type: 'flow:complete', finalState }
      bus.emit(event)

      expect(completeHandler).toHaveBeenCalledWith(event)
      const received = completeHandler.mock.calls[0][0] as FlowCompleteEvent
      expect(received.finalState).toEqual(finalState)
    })

    it('handles node:error events', () => {
      const bus = new EventBus()
      const errorHandler = vi.fn()
      bus.subscribe('node:error', errorHandler)

      const err = new Error('something went wrong')
      bus.emit({ type: 'node:error', nodeId: 'n2', error: err })

      expect(errorHandler).toHaveBeenCalledOnce()
      const received = errorHandler.mock.calls[0][0] as RuntimeEvent
      expect(received.type).toBe('node:error')
    })
  })

  describe('event types coverage', () => {
    it('emits and receives node:complete events', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      bus.subscribe('node:complete', handler)

      bus.emit({ type: 'node:complete', nodeId: 'n1', nodeType: 'llm', durationMs: 120, tokenCount: 50 })
      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits and receives flow:paused events', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      bus.subscribe('flow:paused', handler)

      bus.emit({ type: 'flow:paused', nodeId: 'n1', prompt: 'Approve?', resumeSchema: { type: 'object' } })
      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits and receives flow:error events', () => {
      const bus = new EventBus()
      const handler = vi.fn()
      bus.subscribe('flow:error', handler)

      bus.emit({ type: 'flow:error', error: new Error('fatal') })
      expect(handler).toHaveBeenCalledOnce()
    })
  })
})
