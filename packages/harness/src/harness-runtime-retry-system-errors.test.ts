import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// retryFailedSystemErrors: the failed task is re-queued after the ladder's switch only when the executor itself broke (it
// threw, or reported a failure without a kind). An executor that ran out of its own iteration budget is not retried.

const task: Task = {
  id: 't1', description: 'Answer the question', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}
const GAVE_UP = /couldn't complete this/

async function run(executor: (call: number) => unknown, retryFailedSystemErrors: boolean | undefined, retryFailedTask?: boolean) {
  let calls = 0
  const out = await new HarnessRuntime().run('answer', ['answered'], {
    initialTasks: [{ ...task }],
    max_steps: 12,
    toolExecutors: { default: () => executor(++calls) },
    ...(retryFailedSystemErrors !== undefined ? { retryFailedSystemErrors } : {}),
    ...(retryFailedTask !== undefined ? { retryFailedTask } : {}),
  })
  if (out.status !== 'complete') throw new Error('expected a complete run')
  return { calls, reply: String(out.result.finalResult) }
}

const throwsOnce = (call: number) => { if (call === 1) throw new Error('API Error: 500 upstream hiccup'); return 'The answer is 42.' }
const exhaustsOnce = (call: number) =>
  call === 1
    ? { __harnessExecutionStatus: 'failed', __harnessFailureKind: 'exhausted', error: 'Tool loop exceeded 5 iterations' }
    : 'The answer is 42.'
const failsWithoutKindOnce = (call: number) =>
  call === 1 ? { __harnessExecutionStatus: 'failed', error: 'tool returned an error' } : 'The answer is 42.'

describe('retryFailedSystemErrors', () => {
  it('a thrown error (no failure-mode match, nothing else to retry it) is retried once and the turn succeeds', async () => {
    const r = await run(throwsOnce, true)
    expect(r.calls).toBe(2)
    expect(r.reply).toBe('The answer is 42.')
  })

  it('a failure reported without a kind counts as a system error', async () => {
    const r = await run(failsWithoutKindOnce, true)
    expect(r.calls).toBe(2)
    expect(r.reply).toBe('The answer is 42.')
  })

  it('negative control — an exhausted iteration budget is NOT retried: the turn gives up after the one failure', async () => {
    const r = await run(exhaustsOnce, true)
    expect(r.calls).toBe(1)
    expect(r.reply).toMatch(GAVE_UP)
  })

  it('negative control — the option off: a thrown error is not retried either (today)', async () => {
    const r = await run(throwsOnce, undefined)
    expect(r.calls).toBe(1)
    expect(r.reply).toMatch(GAVE_UP)
  })

  it('retryFailedTask still retries everything, including an exhausted budget', async () => {
    const r = await run(exhaustsOnce, undefined, true)
    expect(r.calls).toBe(2)
    expect(r.reply).toBe('The answer is 42.')
  })

  it('a persistent system error is retried exactly once, then the turn gives up gracefully (no stall escalation)', async () => {
    const r = await run(() => { throw new Error('API Error: 500 still broken') }, true)
    expect(r.calls).toBe(2)
    expect(r.reply).toMatch(GAVE_UP)
  })
})
