import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import { InMemoryExperienceStore } from './state/experience-store.js'
import { buildStrategyOrdering } from './nodes/rollback-replan.js'
import type { Task } from './state/task-graph.js'

// HarnessRunOptions.experienceLearning: a finished (or halted) run writes the journal and teaches the experience store what
// the recovery ladder and the reviewer read. Off ⇒ nothing is written.

// Every task writes the same domain, so none is dispatched in parallel with another: each one goes through the main path (the
// journal records the main path's executions only; a parallel branch's task does not go through the recovery ladder).
const task = (id: string, dependsOn: string[] = []): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: dependsOn,
  parallel_write_domains: ['shared'], abstraction_level: 1, assigned_strategy: null,
})

// t1 fails; the ladder switches strategy; the independent t2 then succeeds under the new strategy.
async function runOneFailureThenSuccess(experienceLearning: boolean | undefined, store: InMemoryExperienceStore) {
  const outcome = await new HarnessRuntime().run('do two things', ['done'], {
    initialTasks: [task('t1'), task('t2')],
    max_steps: 20,
    experienceStore: store,
    experienceLearning,
    toolExecutors: { default: (ctx: { currentTaskId?: string }) => (ctx.currentTaskId === 't1' ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }) },
  } as never)
  return outcome
}

describe('experience learning through a real run', () => {
  it('off (the default): the store is never written and the recovery order is the default', async () => {
    const store = new InMemoryExperienceStore()
    await runOneFailureThenSuccess(undefined, store)
    expect(store.getStrategyWeights()).toEqual({})
    expect(store.getClassPriors()).toEqual({})
  })

  it('on: the strategy that answered the failure is credited, and the ladder now prefers it for that (unmatched) class', async () => {
    const store = new InMemoryExperienceStore()
    const outcome = await runOneFailureThenSuccess(true, store)
    expect(outcome.status).toBe('complete')
    const w = store.getStrategyWeights()
    // The first attempt used DIRECT_EDIT and failed; the ladder switched to TRACE_EXEC, under which t2 succeeded.
    expect(w['TRACE_EXEC:']).toBeGreaterThan(0.5)
    expect(w['DIRECT_EDIT:']).toBe(0.5) // the failing attempt is the trigger, not the answer
    expect(buildStrategyOrdering('', store)[0]).toBe('TRACE_EXEC')
  })

  it('on: a run that halts still learns — the failing runs are the informative ones', async () => {
    const store = new InMemoryExperienceStore()
    const outcome = await new HarnessRuntime().run('do six things', ['done'], {
      initialTasks: ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => task(id)),
      max_steps: 40,
      experienceStore: store,
      experienceLearning: true,
      toolExecutors: { default: () => ({ __harnessExecutionStatus: 'failed', error: 'down' }) },
    } as never).catch((e: unknown) => ({ status: 'threw', error: String(e) }))
    expect(outcome.status).toBe('threw')
    // failures answered by further failures: the strategies that were tried and failed are pushed below the untried ones
    const w = store.getStrategyWeights()
    expect(Object.keys(w).length).toBeGreaterThan(0)
    expect(Math.min(...Object.values(w))).toBeLessThan(0.5)
  })

  it('a paused run does not learn; the resumed run learns once, from the whole journal', async () => {
    const store = new InMemoryExperienceStore()
    const runtime = new HarnessRuntime()
    const options = {
      initialTasks: [task('t1'), task('t2'), task('t3')],
      max_steps: 20,
      experienceStore: store,
      experienceLearning: true,
      toolExecutors: { default: (ctx: { currentTaskId?: string }) => (ctx.currentTaskId === 't1' ? { __harnessExecutionStatus: 'failed', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }) },
    }
    // Pause after the second executed task: the journal already holds a failure and the attempt that answered it.
    const paused = await runtime.run('do three things', ['done'], {
      ...options,
      shouldPause: (cp: { runState: { memoryState: { journal: unknown[] } } }) => cp.runState.memoryState.journal.length >= 2,
    } as never)
    expect(paused.status).toBe('paused')
    expect(store.getStrategyWeights()).toEqual({})
    if (paused.status !== 'paused') throw new Error('unreachable')

    const done = await runtime.resume(paused.checkpoint, options as never)
    expect(done.status).toBe('complete')
    // One update, not two: PRIOR * (1 - rate) + 1 * rate — a run that had learned at the pause too would read 0.755.
    expect(store.getStrategyWeights()['TRACE_EXEC:']).toBeCloseTo(0.65, 4)
  })
})
