// S2 of plans/harness_trajectory_supervisor_plan.html.
//
// The coercion + fail-open contract of the driveMainLoop wiring lives in
// resolveSupervisorDirective() (tested exhaustively in supervisor.test.ts, since
// forcing HarnessRuntime.run() into a real failed-task-under-stall state from a unit
// test is impractical — the control-state resolver BLOCKs a run that can verify
// nothing long before enough execution failures accumulate to trip a stall proxy;
// that path is exercised for real by S7's benchmark corpus). These two tests only
// assert the wiring is present and inert-by-default, and never destabilises a run.

import { describe, it, expect, vi } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'
import { EscalationHalt } from './nodes/escalate.js'

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

describe('driveMainLoop — trajectory supervisor wiring', () => {
  it('is never consulted when no supervisorDecider is supplied', async () => {
    const onSupervisorDirective = vi.fn()
    const outcome = await new HarnessRuntime().run('objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 6,
      toolExecutors: { default: () => ({ completed: true }) },
      onSupervisorDirective,
    })
    expect(outcome.status).toBe('complete')
    expect(onSupervisorDirective).not.toHaveBeenCalled()
  })

  it('a supplied decider + a throwing onSupervisorDirective never surface as an unexpected error', async () => {
    let sawUnexpected: unknown = null
    let halt: EscalationHalt | null = null
    try {
      await new HarnessRuntime().run('failing objective', ['done'], {
        initialTasks: [makeTask('t1'), makeTask('t2'), makeTask('t3')],
        max_steps: 12,
        toolExecutors: { default: () => ({ __harnessExecutionStatus: 'failed', error: 'boom' }) },
        supervisorDecider: async () => ({ action: 'ABORT', rationale: 'give up' }),
        onSupervisorDirective: () => {
          throw new Error('handler bug')
        },
      })
    } catch (e) {
      if (e instanceof EscalationHalt) halt = e
      else sawUnexpected = e
    }
    expect(sawUnexpected).toBeNull()
    // If the run stalled and the ABORT fired, it must halt as a cannot_make_progress
    // escalation carrying the supervisor's rationale — never a raw crash (S6).
    if (halt && halt.blocker.current_task_summary.includes('supervisor ABORT')) {
      expect(halt.blocker.reason).toBe('cannot_make_progress')
      expect(halt.blocker.current_task_summary).toContain('give up')
    }
  })
})
