import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type GateDecisionEvent } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// execution_ratio_min_attempts, end to end: a failure early in a run is not read as a total collapse.

const task = (id: string): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

async function run(ids: string[], failing: (id: string) => boolean) {
  const executed: string[] = []
  const gates: GateDecisionEvent[] = []
  const controlState: string[] = []
  const outcome = await new HarnessRuntime()
    .run('do the tasks', ['done'], {
      initialTasks: ids.map(task),
      max_steps: 20,
      toolExecutors: {
        default: (ctx) => {
          executed.push(ctx.currentTaskId ?? '?')
          return failing(ctx.currentTaskId ?? '') ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }
        },
      },
      onGateDecision: (g) => gates.push(g),
      onLayerActivity: (e) => { if (e.layer === 'control_state') controlState.push(e.reason) },
    })
    .catch(() => ({ status: 'threw' as const }))
  return { executed, gates, controlState, outcome }
}

describe('early failures do not block the run before the minimum sample', () => {
  it('a single failed task never reads "Pausing — blocked" (it used to, at the very next gate)', async () => {
    const { controlState } = await run(['t1'], () => true)
    expect(controlState.some((r) => r.startsWith('Pausing'))).toBe(false)
  })

  it('three tasks that all fail each get their attempt; the block comes only after the third, once', async () => {
    const { executed, gates } = await run(['t1', 't2', 't3'], () => true)
    expect(executed).toEqual(['t1', 't2', 't3'])
    // Before the guard: t3 was BLOCKed after two failures, over and over, until the step ceiling threw.
    expect(gates.length).toBeLessThanOrEqual(1)
  })

  it('one failure among successes is unaffected', async () => {
    const { executed, gates } = await run(['t1', 't2', 't3'], (id) => id === 't1')
    expect(executed).toEqual(['t1', 't2', 't3'])
    expect(gates).toEqual([])
  })
})
