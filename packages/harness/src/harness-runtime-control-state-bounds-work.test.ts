import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// What the control_state resolver is for, measured at the harness level (no LLM): when the environment is
// persistently broken, the resolver bounds the run. With it off (`skipControlState`, the eval ablation) the
// same run keeps attempting and re-planning until the step budget halts it.
//
// Not reachable through the personal assistant's ordinary flow: its decomposed graphs have dependencies, so
// two failed root tasks leave nothing selectable and the run ends there — before the >=3 attempted tasks the
// ratio dimensions need (execution_ratio_min_attempts). See eval/layers/control_state/iterations.md rows 4-8.

const task = (id: string): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

async function run(skipControlState: boolean) {
  const executed: string[] = []
  const gates: string[] = []
  const outcome = await new HarnessRuntime()
    .run('do six independent errands', ['done'], {
      initialTasks: ['t1', 't2', 't3', 't4', 't5', 't6'].map(task),
      max_steps: 40,
      skipControlState,
      toolExecutors: {
        default: (ctx) => {
          executed.push(ctx.currentTaskId ?? '?')
          return { __harnessExecutionStatus: 'failed', error: 'the environment is down' }
        },
      },
      onGateDecision: (g) => gates.push(g.result),
    })
    .then((o) => o.status as string)
    .catch((e: unknown) => `threw: ${String(e).slice(0, 60)}`)
  return { executed, gates, outcome }
}

describe('control_state bounds the work of a persistently failing run', () => {
  it('resolver on: a handful of attempts, then the gate blocks until the step budget halts the run', async () => {
    const { executed, gates, outcome } = await run(false)
    expect(executed.length).toBeLessThanOrEqual(4)
    expect(gates.length).toBeGreaterThan(0)
    expect(new Set(gates)).toEqual(new Set(['BLOCK']))
    expect(outcome).toContain('budget_exhausted')
  })

  it('resolver off: the same run keeps attempting and re-planning — an order of magnitude more executions, and no block', async () => {
    const off = await run(true)
    const on = await run(false)
    expect(off.gates).toEqual([])
    expect(off.executed.length).toBeGreaterThanOrEqual(on.executed.length * 5)
    expect(off.executed.some((id) => id.startsWith('rebuilt-task'))).toBe(true)
    expect(off.outcome).toContain('budget_exhausted')
  })
})
