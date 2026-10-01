import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import { contextCompression } from './nodes/context-compression.js'
import { MemoryState } from './state/memory-state.js'
import { WorldModel, BeliefDepGraph, DepGraphBudget } from './state/world-model.js'
import { HypothesisSet } from './state/hypothesis-set.js'
import { TaskGraph } from './state/task-graph.js'
import { Diagnostics } from './state/diagnostics.js'
import { ControlState } from './state/control-state.js'
import { CallerState } from './state/caller-state.js'
import type { Task } from './state/task-graph.js'

// tokenBudget: the opt-in feed for memory.token_budget (it used to read 0 of 200,000 forever).

const task: Task = {
  id: 't1', description: 'Summarise the notes', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}

async function runWith(tokenBudget?: { total: number; used: () => number }) {
  const outcome = await new HarnessRuntime().run('summarise', ['summary written'], {
    initialTasks: [{ ...task }],
    max_steps: 5,
    toolExecutors: { default: () => 'done' },
    ...(tokenBudget ? { tokenBudget } : {}),
  })
  if (outcome.status !== 'complete') throw new Error('expected a complete run')
  return outcome.result.initResult.memoryState.token_budget
}

describe('HarnessRunOptions.tokenBudget', () => {
  it('feeds token_budget from the host reader and the configured total', async () => {
    expect(await runWith({ total: 1000, used: () => 420 })).toEqual({ total: 1000, used: 420 })
  })

  it('negative control — absent: the budget keeps its defaults (0 of 200,000)', async () => {
    expect(await runWith()).toEqual({ total: 200000, used: 0 })
  })

  it('a throwing or nonsense reader leaves the pressure at 0 and never breaks the run', async () => {
    expect((await runWith({ total: 1000, used: () => { throw new Error('boom') } })).used).toBe(0)
    expect((await runWith({ total: 1000, used: () => Number.NaN })).used).toBe(0)
    expect((await runWith({ total: 1000, used: () => -5 })).used).toBe(0)
  })
})

describe('contextCompression above the pressure threshold', () => {
  function compress(memoryState: MemoryState) {
    contextCompression(
      memoryState, new WorldModel(), new BeliefDepGraph(), new DepGraphBudget(), new HypothesisSet(),
      new TaskGraph(), new Diagnostics(), new ControlState(), new CallerState(),
    )
  }

  it('does not re-append an already recorded pruned region on every pass', () => {
    const memoryState = new MemoryState({ token_budget: { total: 1000, used: 950 } })
    memoryState.compression_risk.pruned_regions.push({ id: 'h1', description: 'eliminated hypothesis', token_count: 12, pruned_at: '2026-10-01T00:00:00.000Z' })
    compress(memoryState)
    compress(memoryState)
    compress(memoryState)
    expect(memoryState.compression_risk.pruned_regions.map((r) => r.id)).toEqual(['h1'])
  })
})
