import { describe, it, expect } from 'vitest'
import { FlowState } from './state'
import type { StateSchema } from '@buildaharness/canvas'

const schema: StateSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    tags: { type: 'array' },
    nested: { type: 'object' },
    flag: { type: 'boolean' },
  },
}

describe('FlowState', () => {
  it('get/set/patch round-trips preserve type across string, number, object', () => {
    const state = new FlowState()
    state.set('str', 'hello')
    state.set('num', 42)
    state.set('obj', { a: 1 })
    expect(state.get('str')).toBe('hello')
    expect(state.get('num')).toBe(42)
    expect(state.get('obj')).toEqual({ a: 1 })
  })

  it('patch() merges partial update without overwriting unrelated keys', () => {
    const state = new FlowState()
    state.set('x', 1)
    state.set('y', 2)
    state.patch({ z: 3 })
    expect(state.get('x')).toBe(1)
    expect(state.get('y')).toBe(2)
    expect(state.get('z')).toBe(3)
  })

  it('snapshot() produces deep-independent copy — mutation of copy does not affect original', () => {
    const state = new FlowState()
    state.set('obj', { a: 1 })
    const copy = state.snapshot()
    copy.set('obj', { a: 99 })
    expect(state.get('obj')).toEqual({ a: 1 })
  })

  it('set() validates against state_schema type if schema defined; throws on mismatch', () => {
    const state = new FlowState(schema)
    state.set('count', 5) // valid number
    expect(state.get('count')).toBe(5)
    expect(() => state.set('count', 'not-a-number')).toThrow()
  })

  it('serialises to and from plain JSON without loss', () => {
    const state = new FlowState()
    state.set('q', 'hello')
    state.set('arr', [1, 2, 3])
    const json = state.toJSON()
    const restored = FlowState.fromJSON(json)
    expect(restored.get('q')).toBe('hello')
    expect(restored.get('arr')).toEqual([1, 2, 3])
  })

  it('initialises default values from schema properties', () => {
    const s: StateSchema = {
      type: 'object',
      properties: { count: { type: 'number', default: 0 } },
    }
    const state = new FlowState(s)
    expect(state.get('count')).toBe(0)
  })
})
