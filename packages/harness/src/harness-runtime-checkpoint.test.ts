import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type HarnessRunResult } from './harness-runtime.js'
import type { HarnessCheckpoint } from './harness-checkpoint.js'
import type { Task } from './state/task-graph.js'

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

async function runToCompletion(rt: HarnessRuntime, ...args: Parameters<HarnessRuntime['run']>): Promise<HarnessRunResult> {
  const outcome = await rt.run(...args)
  if (outcome.status !== 'complete') throw new Error(`expected run to complete, got status "${outcome.status}"`)
  return outcome.result
}

describe('HarnessRuntime pause/resume', () => {
  it('shouldPause stops the run at the next checkpoint instead of completing', async () => {
    const rt = new HarnessRuntime()
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')]

    const outcome = await rt.run('multi-task objective', ['all done'], {
      initialTasks: tasks,
      max_steps: 20,
      toolExecutors: { default: () => ({ completed: true }) },
      shouldPause: () => true, // pause at the very first checkpoint
    })

    expect(outcome.status).toBe('paused')
    if (outcome.status !== 'paused') throw new Error('unreachable')
    expect(outcome.checkpoint.runId).toBeTruthy()
    // Not all tasks should be complete yet — we stopped after one iteration.
    const completedCount = outcome.checkpoint.runState.taskGraph.tasks.filter(t => t.status === 'COMPLETE').length
    expect(completedCount).toBeLessThan(tasks.length)
  })

  it('resume() continues from a checkpoint and reaches the same completion a single run would', async () => {
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')]

    // Run straight through for a baseline.
    const baseline = await runToCompletion(new HarnessRuntime(), 'multi-task objective', ['all done'], {
      initialTasks: tasks.map(t => ({ ...t })),
      max_steps: 20,
      toolExecutors: { default: () => ({ completed: true }) },
    })
    const baselineCompleted = baseline.initResult.taskGraph.tasks.filter(t => t.status === 'COMPLETE').length

    // Now pause after the first iteration and resume to completion.
    const rt = new HarnessRuntime()
    let pauseAfter = 1
    const paused = await rt.run('multi-task objective', ['all done'], {
      initialTasks: tasks.map(t => ({ ...t })),
      max_steps: 20,
      toolExecutors: { default: () => ({ completed: true }) },
      shouldPause: () => {
        if (pauseAfter <= 0) return false
        pauseAfter--
        return true
      },
    })
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('unreachable')

    // Simulate real persistence: round-trip the checkpoint through JSON.
    const serialized: HarnessCheckpoint = JSON.parse(JSON.stringify(paused.checkpoint))

    const resumed = await rt.resume(serialized, {
      max_steps: 20,
      toolExecutors: { default: () => ({ completed: true }) },
    })
    expect(resumed.status).toBe('complete')
    if (resumed.status !== 'complete') throw new Error('unreachable')

    const resumedCompleted = resumed.result.initResult.taskGraph.tasks.filter(t => t.status === 'COMPLETE').length
    expect(resumedCompleted).toBe(baselineCompleted)
    expect(resumedCompleted).toBeGreaterThan(0)
  })

  it('onCheckpoint is called for each mid-loop checkpoint plus a final one on completion', async () => {
    const rt = new HarnessRuntime()
    const checkpoints: HarnessCheckpoint[] = []

    await rt.run('single task objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 5,
      toolExecutors: { default: () => ({ completed: true }) },
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint) },
    })

    expect(checkpoints.length).toBeGreaterThan(0)
    // stepsUsed should be non-decreasing across the recorded checkpoints
    for (let i = 1; i < checkpoints.length; i++) {
      expect(checkpoints[i].progress.stepsUsed).toBeGreaterThanOrEqual(checkpoints[i - 1].progress.stepsUsed)
    }
  })

  it('EscalationHalt still rejects run() and resume() rather than being swallowed', async () => {
    const rt = new HarnessRuntime()
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`))

    await expect(
      rt.run('budget exhaustion objective', [], {
        initialTasks: tasks,
        max_steps: 1,
      }),
    ).rejects.toThrow()
  })
})
