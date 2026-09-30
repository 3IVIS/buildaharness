import { describe, it, expect, afterEach } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// changeReviewFacts: caller-trusted facts reach the semantic change reviewer on the FIRST task of a
// single-task turn, without going through the world model (whose beliefs only appear after a task
// executes). Runs with the lexical checks off — the semantic path is the one that must work.

const task: Task = {
  id: 't1',
  description: 'Build the catering plan around the three-year agreement',
  status: 'PENDING',
  risk_level: 'LOW',
  depends_on: [],
  parallel_write_domains: [],
  abstraction_level: 1,
  assigned_strategy: null,
}
const POLICY = 'our budget policy caps every vendor contract at twelve months'

describe('changeReviewFacts', () => {
  const prev = process.env.HARNESS_LEXICAL_OFF
  afterEach(() => {
    if (prev === undefined) delete process.env.HARNESS_LEXICAL_OFF
    else process.env.HARNESS_LEXICAL_OFF = prev
  })

  it('shows the supplied fact to the semantic reviewer on the first task', async () => {
    process.env.HARNESS_LEXICAL_OFF = '1'
    const seen: string[][] = []
    await new HarnessRuntime().run('plan the catering', ['done'], {
      initialTasks: [{ ...task }],
      max_steps: 4,
      toolExecutors: { default: () => 'plan' },
      changeReviewFacts: () => [{ statement: POLICY }],
      semanticChangeReviewer: async (input) => {
        seen.push(input.highConfidenceBeliefs.map((b) => b.statement))
        return { conflict: false }
      },
    })
    expect(seen[0]).toEqual([POLICY])
  })

  it('a reported conflict is advisory: the callback fires once, the task still executes and is not retried', async () => {
    process.env.HARNESS_LEXICAL_OFF = '1'
    let executed = 0
    let reviewerCalls = 0
    const conflicts: Array<{ taskId: string; reason: string }> = []
    await new HarnessRuntime().run('plan the catering', ['done'], {
      initialTasks: [{ ...task }],
      max_steps: 6,
      toolExecutors: { default: () => { executed++; return 'plan' } },
      changeReviewFacts: () => [{ statement: POLICY }],
      semanticChangeReviewer: async () => { reviewerCalls++; return { conflict: true, reason: 'three years exceeds the twelve-month cap' } },
      onReviewConflict: (e) => conflicts.push(e),
    })
    expect(conflicts).toEqual([{ taskId: 't1', reason: 'three years exceeds the twelve-month cap' }])
    expect(reviewerCalls).toBe(1)
    expect(executed).toBe(1)
  })

  it('does not call the reviewer when there are no facts, beliefs or predictions (no extra LLM call)', async () => {
    process.env.HARNESS_LEXICAL_OFF = '1'
    let calls = 0
    await new HarnessRuntime().run('plan the catering', ['done'], {
      initialTasks: [{ ...task }],
      max_steps: 4,
      toolExecutors: { default: () => 'plan' },
      changeReviewFacts: () => [],
      semanticChangeReviewer: async () => { calls++; return { conflict: false } },
    })
    expect(calls).toBe(0)
  })

  it('leaves the world model untouched — the fact is not turned into a belief', async () => {
    process.env.HARNESS_LEXICAL_OFF = '1'
    let last: any
    await new HarnessRuntime().run('plan the catering', ['done'], {
      initialTasks: [{ ...task }],
      max_steps: 4,
      toolExecutors: { default: () => 'plan' },
      onCheckpoint: (c) => { last = c },
      changeReviewFacts: () => [{ statement: POLICY }],
      semanticChangeReviewer: async () => ({ conflict: false }),
    })
    expect((last.runState.worldModel.beliefs as Array<{ statement: string }>).some((b) => b.statement === POLICY)).toBe(false)
  })
})
