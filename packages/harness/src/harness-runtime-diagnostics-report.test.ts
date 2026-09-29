import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type LayerActivityEvent } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

const task = (): Task => ({
  id: 't1', description: 'read', status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

async function runReporting(failFirst: boolean) {
  const events: string[] = []
  let calls = 0
  await new HarnessRuntime().run('read the file', ['done'], {
    initialTasks: [task()],
    max_steps: 12,
    toolExecutors: {
      default: () => {
        calls++
        return failFirst && calls === 1 ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }
      },
    },
    onLayerActivity: (e: LayerActivityEvent) => {
      if (e.layer === 'diagnostics' || e.layer === 'control_state') events.push(`${e.layer}: ${e.reason}`)
    },
  }).catch(() => {})
  return events
}

describe('diagnostics layer report — post-execution change', () => {
  it('a healthy run reports diagnostics once per iteration, never a second line', async () => {
    const events = await runReporting(false)
    const diag = events.filter((e) => e.startsWith('diagnostics'))
    expect(diag.length).toBeGreaterThan(0)
    expect(new Set(diag)).toEqual(new Set(['diagnostics: Health: nominal']))
    // one pre-exec line per control_state line: nothing extra was emitted after execution
    expect(diag.length).toBe(events.filter((e) => e.startsWith('control_state')).length)
  })

  it('a failed execution that changes the verdict is reported right after it, not only at the next iteration', async () => {
    const events = await runReporting(true)
    expect(events).toEqual([
      'diagnostics: Health: nominal', // iteration 1, before the executor runs
      'control_state: NORMAL',
      'diagnostics: a sub-dimension crossed the caution threshold', // iteration 1, right after the failed executor
      'diagnostics: a sub-dimension crossed the caution threshold', // iteration 2, before its gate (unchanged behaviour)
      'control_state: Pausing — blocked',
    ])
  })
})
