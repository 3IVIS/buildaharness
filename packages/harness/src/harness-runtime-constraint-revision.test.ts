import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type SemanticConstraintJudge } from './harness-runtime.js'
import { OutputContractError } from './nodes/output-validation.js'
import type { Task } from './state/task-graph.js'

// onConstraintRevision: a violation found at the END of a run sends the last answer back to the proposer once;
// only a second violation fails the run.

const task: Task = {
  id: 't1', description: 'Write the indentation guide', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}
const BAD = 'Indent with a tab.'
const GOOD = 'Indent with two spaces.'
const judge: SemanticConstraintJudge = async ({ reply }) =>
  reply === BAD ? { violated: [{ constraint: 'Do not use tabs', reason: 'indents with a tab' }] } : { violated: [] }

async function run(replies: string[], opts: { revise: boolean; throwingHandler?: boolean }) {
  let calls = 0
  const events: Array<{ taskId: string; note: string }> = []
  try {
    const outcome = await new HarnessRuntime().run('write the guide', ['guide written'], {
      initialTasks: [{ ...task }],
      max_steps: 8,
      callerConstraints: ['Do not use tabs'],
      toolExecutors: { default: () => replies[Math.min(calls++, replies.length - 1)] },
      semanticConstraintJudge: judge,
      ...(opts.revise
        ? { onConstraintRevision: (e: { taskId: string; note: string }) => { events.push(e); if (opts.throwingHandler) throw new Error('boom') } }
        : {}),
    })
    return { outcome, error: undefined as unknown, calls, events }
  } catch (error) {
    return { outcome: undefined, error, calls, events }
  }
}

describe('onConstraintRevision', () => {
  it('a violation reopens the task once; the second answer passes and is what the run returns', async () => {
    const r = await run([BAD, GOOD], { revise: true })
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status === 'complete' && r.outcome.result.finalResult).toBe(GOOD)
    expect(r.calls).toBe(2)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].taskId).toBe('t1')
    expect(r.events[0].note).toContain('Do not use tabs')
    expect(r.events[0].note).toContain('indents with a tab')
  })

  it('negative control — no handler: the same violation fails the run on the first answer', async () => {
    const r = await run([BAD, GOOD], { revise: false })
    expect(r.error).toBeInstanceOf(OutputContractError)
    expect(r.calls).toBe(1)
  })

  it('a second violation returns the answer with the violation attached, and only one revision is attempted', async () => {
    const r = await run([BAD, BAD, BAD], { revise: true })
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status === 'complete' && r.outcome.result.finalResult).toBe(BAD)
    expect(r.outcome?.status === 'complete' && r.outcome.result.unresolvedConstraintViolations).toEqual([{ constraint: 'Do not use tabs', reason: 'indents with a tab' }])
    expect(r.calls).toBe(2)
    expect(r.events).toHaveLength(1)
  })

  it('a clean answer carries no unresolved violations', async () => {
    const r = await run([BAD, GOOD], { revise: true })
    expect(r.outcome?.status === 'complete' && r.outcome.result.unresolvedConstraintViolations).toBeUndefined()
  })

  it('a clean first answer never fires the handler or asks again', async () => {
    const r = await run([GOOD, BAD], { revise: true })
    expect(r.error).toBeUndefined()
    expect(r.calls).toBe(1)
    expect(r.events).toEqual([])
  })

  it('a throwing handler never breaks the run', async () => {
    const r = await run([BAD, GOOD], { revise: true, throwingHandler: true })
    expect(r.error).toBeUndefined()
    expect(r.calls).toBe(2)
  })
})
