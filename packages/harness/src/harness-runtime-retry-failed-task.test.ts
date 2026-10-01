import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// HarnessRunOptions.retryFailedTask: after the ladder switches strategy, the failed task runs again under it.
const task = (id: string): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: ['shared'], abstraction_level: 1, assigned_strategy: null,
})

async function run(retryFailedTask: boolean | undefined, failFirst: number) {
  let calls = 0
  const outcome = await new HarnessRuntime()
    .run('do one thing', ['done'], {
      initialTasks: [task('t1')],
      max_steps: 20,
      retryFailedTask,
      toolExecutors: {
        default: () => {
          calls += 1
          return calls <= failFirst ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }
        },
      },
    } as never)
    .catch((e: unknown) => ({ status: 'threw', error: String(e) }))
  return { outcome, calls }
}

describe('retryFailedTask through a real run', () => {
  it('off (the default): a lone failed task is run once and not again', async () => {
    const { calls } = await run(undefined, 1)
    expect(calls).toBe(1)
  })

  it('on: the failed task runs again under the switched strategy and the turn completes', async () => {
    const { outcome, calls } = await run(true, 1)
    expect(calls).toBe(2)
    expect(outcome.status).toBe('complete')
  })

  it('on: a task that keeps failing is retried a bounded number of times, never forever', async () => {
    const { calls } = await run(true, 1000)
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThan(15)
  })
})
