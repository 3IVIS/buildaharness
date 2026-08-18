import { describe, it, expect } from 'vitest'
import { Budget } from './budget.js'

describe('Budget', () => {
  it('defaults every dimension to unbounded (Infinity) and zero used', () => {
    const budget = new Budget()
    expect(budget.isExhausted()).toBe(false)
    expect(budget.toJSON()).toEqual({
      maxCalls: Infinity,
      maxCost: Infinity,
      maxTime: Infinity,
      maxParallelism: Infinity,
      callsUsed: 0,
      costUsed: 0,
      timeUsed: 0,
      parallelismUsed: 0,
    })
  })

  it('is exhausted when any single dimension reaches its cap, not just when all do', () => {
    const budget = new Budget({ maxCalls: 5, maxCost: 10 }).consume({ calls: 5, cost: 1 })
    expect(budget.isExhausted()).toBe(true) // calls hit the cap; cost is nowhere near its own
  })

  it('is not exhausted while every dimension is strictly under its cap', () => {
    const budget = new Budget({ maxCalls: 5 }).consume({ calls: 4 })
    expect(budget.isExhausted()).toBe(false)
  })

  it('consume() is immutable — returns a new instance, does not mutate the original', () => {
    const original = new Budget({ maxCalls: 10 })
    const consumed = original.consume({ calls: 3 })
    expect(original.callsUsed).toBe(0)
    expect(consumed.callsUsed).toBe(3)
    expect(consumed).not.toBe(original)
  })

  it('consume() accumulates across multiple calls', () => {
    let budget = new Budget({ maxCalls: 100 })
    budget = budget.consume({ calls: 3 })
    budget = budget.consume({ calls: 4 })
    expect(budget.callsUsed).toBe(7)
  })

  it('remaining() floors at 0 rather than going negative', () => {
    const budget = new Budget({ maxCalls: 5 }).consume({ calls: 9 })
    expect(budget.remaining('calls')).toBe(0)
  })

  it('remaining() reflects unconsumed room', () => {
    const budget = new Budget({ maxCalls: 10 }).consume({ calls: 3 })
    expect(budget.remaining('calls')).toBe(7)
  })

  it('round-trips through toJSON/fromJSON unchanged', () => {
    const budget = new Budget({ maxCalls: 40, maxCost: 2, maxTime: 300, maxParallelism: 3 }).consume({
      calls: 12,
      cost: 0.5,
      time: 30,
      parallelism: 1,
    })
    const restored = Budget.fromJSON(budget.toJSON())
    expect(restored.toJSON()).toEqual(budget.toJSON())
  })
})
