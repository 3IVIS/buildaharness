import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type SemanticConstraintJudge } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// A run that stalls on a failed task ends with the harness's own could-not-complete reply. That text is a notice, not an
// answer: judging it against the user's constraints ("two sentences", "friendly") used to throw OutputContractError and
// turn a graceful failure message into a failed turn.

const task: Task = {
  id: 't1', description: 'Write the announcement', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}

async function run(failing: boolean) {
  const judged: string[] = []
  const judge: SemanticConstraintJudge = async ({ reply }) => {
    judged.push(reply)
    return { violated: [{ constraint: 'Write two sentences', reason: 'not an announcement' }] }
  }
  try {
    const outcome = await new HarnessRuntime().run('write the announcement', ['announcement written'], {
      initialTasks: [{ ...task }],
      max_steps: 12,
      callerConstraints: ['Write two sentences'],
      toolExecutors: { default: () => { if (failing) throw new Error('model call failed'); return 'One sentence here.' } },
      semanticConstraintJudge: judge,
    })
    return { outcome, error: undefined as unknown, judged }
  } catch (error) {
    return { outcome: undefined, error, judged }
  }
}

describe('constraint judge and the could-not-complete reply', () => {
  it('a stalled run returns its could-not-complete reply; the judge never sees it', async () => {
    const r = await run(true)
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status).toBe('complete')
    const text = r.outcome?.status === 'complete' ? String(r.outcome.result.finalResult) : ''
    expect(text).toMatch(/couldn't complete|did not complete|didn't complete/i)
    expect(r.judged).toEqual([])
  })

  it('negative control — a real answer is still judged (and a violation still fails the run)', async () => {
    const r = await run(false)
    expect(r.judged.length).toBeGreaterThan(0)
    expect(r.error).toBeDefined()
  })

  it('the lexical caller-constraint match (opt-in, no judge) does not fire on the could-not-complete reply either', async () => {
    const prev = process.env.HARNESS_LEXICAL_ON
    process.env.HARNESS_LEXICAL_ON = 'constraint-negation'
    try {
    const run2 = async (failing: boolean) => {
      try {
        const outcome = await new HarnessRuntime().run('write the announcement', ['announcement written'], {
          initialTasks: [{ ...task }],
          max_steps: 12,
          callerConstraints: ['Never write the announcement'],
          toolExecutors: { default: () => { if (failing) throw new Error('model call failed'); return 'I will write the announcement tomorrow.' } },
        })
        return { outcome, error: undefined as unknown }
      } catch (error) {
        return { outcome: undefined, error }
      }
    }
    const stalled = await run2(true)
    expect(stalled.error).toBeUndefined()
    expect(stalled.outcome?.status).toBe('complete')
    // negative control: the same lexical match still fails a real answer that breaks the constraint.
    const real = await run2(false)
    expect(real.error).toBeDefined()
    } finally {
      if (prev === undefined) delete process.env.HARNESS_LEXICAL_ON
      else process.env.HARNESS_LEXICAL_ON = prev
    }
  })
})
