// S7 of plans/harness_trajectory_supervisor_plan.html — the benchmark's stall-induction
// mechanism, exercised directly against HarnessRuntime.
//
// A single-task run normally completes in one iteration and never reaches
// cannotMakeProgress(), so the Trajectory Supervisor is never consulted. The benchmark's
// proposer wrapper (personal-assistant/src/benchmark-injected-failure.ts) seeds recurring
// failure records into the run's live failureDiagnostics from inside the toolFn and then
// reports a failed execution — enough for failureRecurring() to trip on the first
// iteration. These tests reproduce that shape with a toolExecutor and assert:
//   1. the supervisor IS consulted on the seeded stall (was never reachable before);
//   2. the recovery ladder's output is adopted (driveMainLoop reassigns rollbackResult
//      back to ctx — the loop.py parity fix) so the run converges instead of silently
//      stopping with the rebuilt task graph discarded.

import { describe, it, expect, vi } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'
import type { ToolExecutorContext } from './nodes/execute.js'

function makeTask(id: string): Task {
  return {
    id,
    description: `Task ${id}`,
    status: 'PENDING',
    risk_level: 'LOW',
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null,
  }
}

/** Twin of benchmark-injected-failure.ts's wrapProposerWithInjectedFailure, minus the caching. */
function seedThenFail(failIterations: number, seedFailures: number) {
  const state = { calls: 0 }
  const fn = (toolCtx: ToolExecutorContext): unknown => {
    state.calls += 1
    if (state.calls === 1) {
      const now = new Date().toISOString()
      for (let k = 0; k < seedFailures; k++) {
        toolCtx.failureDiagnostics?.failure_history.push({
          id: `inj-${k}`,
          timestamp: now,
          failure_class: 'injected_persistent_tool_failure',
          description: 'injected persistent failure',
          context: { injected: true },
        })
      }
      if (toolCtx.failureDiagnostics) {
        toolCtx.failureDiagnostics.matched_pattern = {
          failure_class: 'injected_persistent_tool_failure',
          confidence: 1,
          matched_pattern: 'injected',
        }
      }
    }
    if (state.calls <= failIterations) {
      return { __harnessExecutionStatus: 'failed', error: 'injected: persistent tool failure (ETIMEDOUT)' }
    }
    return { __harnessExecutionStatus: 'complete', output: 'recovered answer' }
  }
  return Object.assign(fn, { state })
}

describe('driveMainLoop — S7 seeded-stall supervisor consult', () => {
  it('consults the supervisor on a seeded failure-recurrence stall', async () => {
    const seen: string[] = []
    await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 8,
      toolExecutors: { default: seedThenFail(1, 3) },
      supervisorDecider: async () => ({ action: 'CONTINUE', rationale: 'keep going' }),
      onSupervisorDirective: (d) => seen.push(d.action),
    }).catch(() => {
      /* an escalation is an acceptable terminal state for this assertion */
    })
    expect(seen.length).toBeGreaterThan(0)
  })

  it('a REFRAME_PLAN directive rebuilds the task graph and the run re-executes over it', async () => {
    // REFRAME_PLAN forces a GLOBAL rebuild inside rollbackAndReplan regardless of the
    // deterministic stall re-check. The parity fix (driveMainLoop reassigning
    // rollbackResult.newTaskGraph back to ctx on a GLOBAL replan) is what lets that rebuild
    // take effect — without it the executor is called exactly once and the loop stops with
    // nothing PENDING.
    const decider = vi.fn(async () => ({
      action: 'REFRAME_PLAN' as const,
      rationale: 'the decomposition is wrong',
      plan_note: 'read the reference file directly instead of the pointer',
    }))
    const exec = seedThenFail(1, 3)
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 12,
      toolExecutors: { default: exec },
      supervisorDecider: decider,
    })
    expect(decider).toHaveBeenCalled()
    expect(exec.state.calls).toBeGreaterThan(1)
    expect(outcome.status).toBe('complete')
  })

  it('lever 1 (S8): a REDIRECT_STRATEGY directive re-queues the failed leaf and the run recovers', async () => {
    // Before S8 only REFRAME_PLAN could recover a one-node stall — REDIRECT_STRATEGY went
    // through the LOCAL replan path, which re-queues only *dependents*, so nothing landed
    // PENDING and the executor was called exactly once. Now the failed leaf itself is
    // re-queued so the redirected strategy gets an attempt.
    const decider = vi.fn(async () => ({
      action: 'REDIRECT_STRATEGY' as const,
      rationale: 'the current strategy keeps timing out',
      strategy_hint: 'REIMPLEMENT',
    }))
    const exec = seedThenFail(1, 3)
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 12,
      toolExecutors: { default: exec },
      supervisorDecider: decider,
    })
    expect(decider).toHaveBeenCalled()
    expect(exec.state.calls).toBeGreaterThan(1)
    expect(outcome.status).toBe('complete')
  })

  it('lever 1 (S8): a completed GATHER_EVIDENCE investigation re-queues the failed leaf', async () => {
    const decider = vi.fn(async () => ({
      action: 'GATHER_EVIDENCE' as const,
      rationale: 'need to check where the value actually lives',
      investigation: { question: 'where is the override defined?', suggested_tools: ['read_file'], budget: 2 },
    }))
    const exec = seedThenFail(1, 3)
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 12,
      toolExecutors: { default: exec },
      supervisorDecider: decider,
      runInvestigation: async () => [{ content: 'override is in config.local.env', tool: 'read_file', reliability: 'MEDIUM' as const }],
    })
    expect(decider).toHaveBeenCalled()
    expect(exec.state.calls).toBeGreaterThan(1)
    expect(outcome.status).toBe('complete')
  })

  it('lever 1 (S8): a REDIRECT that never stops failing still terminates (bounded)', async () => {
    // The re-queue must not create an unbounded retry loop — switch_count -> strategyLooping
    // and the recovery budget still force a terminal state.
    const decider = vi.fn(async () => ({
      action: 'REDIRECT_STRATEGY' as const,
      rationale: 'try again',
      strategy_hint: 'REIMPLEMENT',
    }))
    const alwaysFail = (): unknown => ({ __harnessExecutionStatus: 'failed', error: 'injected: never recovers' })
    const seedFirst = (() => {
      let first = true
      return (toolCtx: ToolExecutorContext): unknown => {
        if (first) {
          first = false
          for (let k = 0; k < 3; k++) {
            toolCtx.failureDiagnostics?.failure_history.push({
              id: `inj-${k}`, timestamp: new Date().toISOString(),
              failure_class: 'injected_persistent_tool_failure', description: 'x', context: {},
            })
          }
          if (toolCtx.failureDiagnostics) {
            toolCtx.failureDiagnostics.matched_pattern = {
              failure_class: 'injected_persistent_tool_failure', confidence: 1, matched_pattern: 'injected',
            }
          }
        }
        return alwaysFail()
      }
    })()
    let terminated = false
    await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 25,
      toolExecutors: { default: seedFirst },
      supervisorDecider: decider,
    }).then(() => { terminated = true }).catch(() => { terminated = true })
    expect(terminated).toBe(true)
  })

  it('F3: a turn that stalls with a FAILED task returns an explicit reply, never an empty one', async () => {
    // No supervisor. A LOCAL replan of a one-node graph re-queues only dependents (none), so the
    // FAILED leaf strands and the loop exits with nothing completed. Before F3 `finalResult` was
    // null → the personal-assistant reply became '' (a silent no-op for the one-loop path).
    const alwaysFail = (): unknown => ({ __harnessExecutionStatus: 'failed', error: 'the tool kept timing out' })
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 12,
      toolExecutors: { default: alwaysFail },
    })
    expect(outcome.status).toBe('complete')
    if (outcome.status === 'complete') {
      expect(typeof outcome.result.finalResult).toBe('string')
      expect(String(outcome.result.finalResult).length).toBeGreaterThan(0)
      expect(String(outcome.result.finalResult)).toMatch(/could ?n['’]?t complete|could not complete/i)
    }
  })

  it('is never consulted on a healthy single-task run (INV-22)', async () => {
    const decider = vi.fn(async () => ({ action: 'CONTINUE' as const, rationale: 'n/a' }))
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [makeTask('respond')],
      max_steps: 8,
      toolExecutors: { default: () => ({ __harnessExecutionStatus: 'complete', output: 'fine' }) },
      supervisorDecider: decider,
    })
    expect(outcome.status).toBe('complete')
    expect(decider).not.toHaveBeenCalled()
  })
})
