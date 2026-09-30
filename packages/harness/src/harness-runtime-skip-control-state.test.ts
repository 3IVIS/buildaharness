import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type GateDecisionEvent } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// Feature-value audit, control_state — `skipControlState` is an eval-only ablation seam. Default
// (absent) must leave the resolver exactly as it was; true pins the harness's own ControlState at
// ALLOW/NORMAL so the action gate never returns BLOCK/ESCALATE from a resolver DENY.

function makeTask(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    description: `Task ${id}`,
    status: 'PENDING',
    risk_level: 'LOW',
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null,
    ...extra,
  }
}

// The scenario the Phase D1 real-BLOCK test uses: two irreconcilable beliefs become a
// SYSTEM_BREAKING contradiction (resolver Tier 1 → DENY) before t2's gate, so with the resolver
// live the gate returns BLOCK for t2. Nothing about ControlState is stubbed.
async function runContradiction(skipControlState?: boolean) {
  const gates: GateDecisionEvent[] = []
  const executed: string[] = []
  await new HarnessRuntime().run('reconcile the two ledgers', ['done'], {
    initialTasks: [makeTask('t1'), makeTask('t2', { depends_on: ['t1'] })],
    max_steps: 8,
    toolExecutors: { default: (ctx) => { executed.push(ctx.currentTaskId ?? "?"); return { completed: true } } },
    factExtractor: () => [
      { statement: 'The Q3 balance is $10,000', isNew: true },
      { statement: 'The Q3 balance is $40,000', isNew: true },
    ],
    contradictionChecker: async (newBeliefs) =>
      newBeliefs.length < 2 ? [] : [{
        beliefIds: [newBeliefs[0].id, newBeliefs[1].id],
        description: 'The two stated Q3 balances cannot both be true',
        severity: 'SYSTEM_BREAKING',
      }],
    onGateDecision: (event) => gates.push(event),
    ...(skipControlState === undefined ? {} : { skipControlState }),
  }).catch(() => {})
  return { gates, executed }
}

describe('HarnessRunOptions.skipControlState (control_state ablation, eval-only)', () => {
  it('default (absent): the SYSTEM_BREAKING contradiction denies the gate — BLOCK for t2, t2 never executes', async () => {
    const { gates, executed } = await runContradiction()
    expect(gates.find((g) => g.result === 'BLOCK')?.taskId).toBe('t2')
    expect(executed).not.toContain('t2')
  })

  it('explicit false is identical to absent', async () => {
    const a = await runContradiction()
    const b = await runContradiction(false)
    expect(b.gates.map((g) => g.result)).toEqual(a.gates.map((g) => g.result))
    expect(b.executed).toEqual(a.executed)
  })

  it('true: the same contradiction never blocks the gate, and t2 executes', async () => {
    const { gates, executed } = await runContradiction(true)
    expect(gates).toEqual([])
    expect(executed).toContain('t2')
  })
})
