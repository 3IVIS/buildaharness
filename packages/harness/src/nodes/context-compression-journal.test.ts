import { describe, it, expect } from 'vitest'
import { contextCompression } from './context-compression.js'
import { MemoryState, WorldModel, BeliefDepGraph, DepGraphBudget, HypothesisSet, TaskGraph, Diagnostics, ControlState, CallerState } from '../index.js'

function run(max: number, compress: boolean, retainFailures = true) {
  const mem = new MemoryState()
  mem.journal_retention_policy = { retain_failures_permanently: retainFailures, max_passing_verbatim: max, compress_older_passing: compress }
  mem.journal = Array.from({ length: 6 }, (_, i) => ({ step: i, action_class: 'DIRECT_EDIT', outcome: i % 3 ? 'completed' : 'failed:X', success: i % 3 !== 0, ...(i % 3 ? { verbatim: `v${i}` } : {}) }))
  contextCompression(mem, new WorldModel(), new BeliefDepGraph(), new DepGraphBudget(), new HypothesisSet(), new TaskGraph(), new Diagnostics(), new ControlState(), new CallerState())
  return mem.journal
}

describe('journal retention policy', () => {
  it('max_passing_verbatim = 0 keeps no passing entry verbatim (was: slice(-0) kept all of them)', () => {
    const j = run(0, true)
    expect(j.filter((e) => e.success).every((e) => e.verbatim === undefined)).toBe(true)
    expect(j.filter((e) => e.success)).toHaveLength(4) // compressed, not dropped
  })
  it('max_passing_verbatim = 0 without compression drops passing entries, keeps failures', () => {
    const j = run(0, false)
    expect(j.every((e) => !e.success)).toBe(true)
    expect(j).toHaveLength(2)
  })
  it('max_passing_verbatim = 2 keeps the last two verbatim and compresses the rest', () => {
    const j = run(2, true)
    expect(j.filter((e) => e.verbatim !== undefined).map((e) => e.step)).toEqual([4, 5].filter((s) => s % 3))
    expect(j.filter((e) => e.success)).toHaveLength(4)
  })
  it('a max larger than the passing count changes nothing', () => {
    expect(run(50, true).filter((e) => e.verbatim !== undefined)).toHaveLength(4)
  })
})
