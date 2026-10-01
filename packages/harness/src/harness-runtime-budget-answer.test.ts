import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type HarnessRunOptions } from './harness-runtime.js'
import type { HarnessCheckpoint } from './harness-checkpoint.js'
import { EscalationHalt } from './nodes/escalate.js'
import { buildBudgetExhaustedQuestion } from './ask-question.js'
import type { UpdateChannel } from './nodes/check-caller-updates.js'
import type { Task } from './state/task-graph.js'

// The budget_exhausted halt and its structured question: (1) running out of budget with every task already COMPLETE is
// not a halt; (2) the user's answer to the question takes effect on resume — "Continue" extends the step limit,
// "Stop" ends the run with what is done.

const chain = (n: number): Task[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, description: `Step ${i + 1}`, status: 'PENDING' as const, risk_level: 'LOW' as const,
    depends_on: i === 0 ? [] : [`t${i}`], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
  }))

function baseOptions(over: Partial<HarnessRunOptions>): HarnessRunOptions & { executed: () => number } {
  let executed = 0
  return {
    initialTasks: chain(3),
    toolExecutors: { default: () => { executed++; return `done ${executed}` } },
    askMode: 'enabled',
    ...over,
    executed: () => executed,
  }
}

/** Runs until the budget halt and returns the halt plus the last checkpoint written before it. */
async function runToHalt(maxSteps: number) {
  const checkpoints: HarnessCheckpoint[] = []
  const opts = baseOptions({ max_steps: maxSteps, onCheckpoint: async (cp) => { checkpoints.push(JSON.parse(JSON.stringify(cp)) as HarnessCheckpoint) } })
  let halt: unknown
  try {
    await new HarnessRuntime().run('do three things', ['all three done'], opts)
  } catch (e) {
    halt = e
  }
  return { halt, checkpoint: checkpoints.at(-1), opts }
}

function answering(label: string): UpdateChannel {
  const q = buildBudgetExhaustedQuestion(0)
  let sent = false
  return {
    poll: () => (sent ? null : ((sent = true), { pending_update: { clarification_answers: [{ questionId: q.id, kind: 'selected', selectedLabels: [label] }], ask_questions: [q] }, constraints_changed: true })),
  }
}

describe('budget exhaustion with all work done', () => {
  it('a budget that exactly covers the tasks completes instead of halting', async () => {
    const opts = baseOptions({ max_steps: 3 })
    const outcome = await new HarnessRuntime().run('do three things', ['all three done'], opts)
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    expect(outcome.result.initResult.taskGraph.tasks.every((t) => t.status === 'COMPLETE')).toBe(true)
    expect(opts.executed()).toBe(3)
  })

  it('a budget that does NOT cover the tasks still halts (unchanged), with the structured question in ask mode', async () => {
    const { halt } = await runToHalt(2)
    expect(halt).toBeInstanceOf(EscalationHalt)
    expect((halt as EscalationHalt).blocker.reason).toBe('budget_exhausted')
    expect((halt as EscalationHalt).blocker.questions?.[0]?.id).toBe('budget-exhausted-resolution')
  })
})

describe('the answer to the budget question takes effect on resume', () => {
  it('"Continue with N more steps" extends the step limit, so the paused run finishes the remaining tasks', async () => {
    const { checkpoint } = await runToHalt(2)
    expect(checkpoint).toBeDefined()
    const label = buildBudgetExhaustedQuestion(0).options![0].label
    const resumeOpts = baseOptions({ max_steps: 2, updateChannel: answering(label) })
    const outcome = await new HarnessRuntime().resume(checkpoint!, resumeOpts)
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    // exactly the three original tasks — the answer must not reach the constraint pipeline (which used to drop t3 as out of scope and invent a new task)
    expect(outcome.result.initResult.taskGraph.tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'COMPLETE'], ['t2', 'COMPLETE'], ['t3', 'COMPLETE']])
    expect(outcome.result.initResult.maxSteps).toBe(12)
    expect(resumeOpts.executed()).toBe(2) // the interrupted t2 replays, then t3
  })

  it('"Stop and summarize" blocks what is not done and ends the run without starting any further task', async () => {
    const { checkpoint } = await runToHalt(2)
    const label = buildBudgetExhaustedQuestion(0).options![1].label
    const resumeOpts = baseOptions({ max_steps: 2, updateChannel: answering(label) })
    const outcome = await new HarnessRuntime().resume(checkpoint!, resumeOpts)
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    const tasks = outcome.result.initResult.taskGraph.tasks
    expect(tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'COMPLETE'], ['t2', 'COMPLETE'], ['t3', 'BLOCKED']])
    expect(tasks[2].block_reason).toBe('goal_cancelled')
    expect(outcome.result.initResult.maxSteps).toBe(2)
    expect(resumeOpts.executed()).toBe(1) // only the interrupted t2 replays; t3 never runs
  })

  it('"Let me clarify the goal" changes no budget: the resumed run halts again at the same limit', async () => {
    const { checkpoint } = await runToHalt(2)
    const label = buildBudgetExhaustedQuestion(0).options![2].label
    const resumeOpts = baseOptions({ max_steps: 2, updateChannel: answering(label) })
    await expect(new HarnessRuntime().resume(checkpoint!, resumeOpts)).rejects.toBeInstanceOf(EscalationHalt)
  })
})
