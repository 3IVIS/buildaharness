import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type LayerActivityEvent } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

const task = (id: string): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

async function runReporting(failing: (id: string) => boolean, ids = ['t1']) {
  const events: string[] = []
  await new HarnessRuntime().run('read the file', ['done'], {
    initialTasks: ids.map(task),
    max_steps: 12,
    toolExecutors: {
      default: (ctx) => (failing(ctx.currentTaskId ?? '') ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }),
    },
    onLayerActivity: (e: LayerActivityEvent) => {
      if (e.layer === 'diagnostics' || e.layer === 'control_state') events.push(`${e.layer}: ${e.reason}`)
    },
  }).catch(() => {})
  return events
}

describe('diagnostics layer report — post-execution change', () => {
  it('a healthy run reports diagnostics once per iteration, never a second line', async () => {
    const events = await runReporting(() => false)
    const diag = events.filter((e) => e.startsWith('diagnostics'))
    expect(diag.length).toBeGreaterThan(0)
    expect(new Set(diag)).toEqual(new Set(['diagnostics: Health: nominal']))
    // one pre-exec line per control_state line: nothing extra was emitted after execution
    expect(diag.length).toBe(events.filter((e) => e.startsWith('control_state')).length)
  })

  it('an execution that changes the verdict is reported right after it, not only at the next iteration', async () => {
    // Three tasks that all fail: the ratios only apply from the third attempt (execution_ratio_min_attempts),
    // so the verdict flips to caution during the third execution. One extra diagnostics line marks it.
    const events = await runReporting(() => true, ['t1', 't2', 't3'])
    const diag = events.filter((e) => e.startsWith('diagnostics'))
    const control = events.filter((e) => e.startsWith('control_state'))
    expect(diag.length).toBe(control.length + 1)
    expect(events).toEqual([
      'diagnostics: Health: nominal',
      'control_state: NORMAL',
      'diagnostics: Health: nominal',
      'control_state: NORMAL',
      'diagnostics: a sub-dimension crossed the caution threshold', // right after the third failed execution
      'diagnostics: a sub-dimension crossed the caution threshold', // next iteration, before its gate (unchanged behaviour)
      'control_state: Pausing — blocked',
    ])
  })
})
