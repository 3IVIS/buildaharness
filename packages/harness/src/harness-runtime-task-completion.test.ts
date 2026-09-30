import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type SemanticTaskCompletion } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// semanticTaskCompletion: the harness completes a task only if the host says the output actually did it.

const task: Task = {
  id: 't1',
  description: 'Agree scope and metrics for the Q3 redesign',
  status: 'PENDING',
  risk_level: 'MEDIUM',
  depends_on: [],
  parallel_write_domains: [],
  abstraction_level: 1,
  assigned_strategy: null,
}
const complexitySignal = { riskLevel: 'MEDIUM' as const, taskCount: 1, hasDurablePlan: false, consequentialTools: new Set<string>() }

async function runWith(hook: SemanticTaskCompletion | undefined, maxSteps = 6) {
  const layers: Array<{ layer: string; reason: string }> = []
  const beliefs: string[] = []
  let executed = 0
  const outcome = await new HarnessRuntime().run('agree scope', ['scope agreed'], {
    initialTasks: [{ ...task }],
    max_steps: maxSteps,
    complexitySignal,
    toolExecutors: { default: () => { executed++; return "I can't do that." } },
    semanticTaskCompletion: hook,
    semanticCriterionCoverage: async (_c, b) => { beliefs.push(...b.map((x) => x.statement)); return false },
    onLayerActivity: (e) => layers.push(e),
  })
  const status = outcome.status === 'complete' ? outcome.result.initResult.taskGraph.tasks.find((t) => t.id === 't1')?.status : undefined
  return { outcome, layers, beliefs, executed, status }
}

describe('semanticTaskCompletion', () => {
  it('absent: the executor returning completes the task, as before', async () => {
    const r = await runWith(undefined)
    expect(r.status).toBe('COMPLETE')
    expect(r.executed).toBe(1)
  })

  it('done: the task completes and the check saw the description and output', async () => {
    const seen: Array<{ taskDescription: string; output: unknown }> = []
    const r = await runWith(async (i) => { seen.push(i); return { done: true } })
    expect(r.status).toBe('COMPLETE')
    expect(seen).toEqual([{ taskDescription: task.description, output: "I can't do that." }])
  })

  it('not done: the task fails like a thrown executor (FAILED, stranded reply names the step and the reason) and gets no Completed: belief', async () => {
    const r = await runWith(async () => ({ done: false, reason: 'the reply refused' }))
    expect(r.status).toBe('FAILED')
    // The stranded reply says which step and why, not a generic "ran into a problem".
    const finalResult = (r.outcome as { result?: { finalResult?: unknown } }).result?.finalResult
    expect(finalResult).toContain(task.description)
    expect(finalResult).toContain('the reply refused')
    expect(r.layers.some((l) => l.layer === 'verification' && l.reason.includes('task not accomplished — the reply refused'))).toBe(true)
    expect(r.beliefs.some((b) => b.startsWith('Completed: '))).toBe(false)
  })

  it('reports each not-done verdict to onTaskNotAccomplished with the task id and reason', async () => {
    const events: Array<{ taskId: string; reason: string }> = []
    await new HarnessRuntime().run('agree scope', ['scope agreed'], {
      initialTasks: [{ ...task }],
      max_steps: 6,
      complexitySignal,
      toolExecutors: { default: () => "I can't do that." },
      semanticTaskCompletion: async () => ({ done: false, reason: 'the reply refused' }),
      onTaskNotAccomplished: (e) => { events.push(e); throw new Error('a throwing handler must not break the run') },
    })
    expect(events).toEqual([{ taskId: 't1', reason: 'the reply refused' }])
  })

  it('a check that throws never blocks a task the executor completed', async () => {
    const r = await runWith(async () => { throw new Error('llm down') })
    expect(r.status).toBe('COMPLETE')
  })

  it('on a simple chain, a rejected last step does not re-run the steps already accepted', async () => {
    const ids = ['a', 'b', 'c']
    const tasks: Task[] = ids.map((id, i) => ({ ...task, id, description: `Step ${id}`, depends_on: i === 0 ? [] : [ids[i - 1]] }))
    const runs: string[] = []
    const outcome: any = await new HarnessRuntime().run('do the plan', ['plan done'], {
      initialTasks: tasks,
      max_steps: 12,
      skipReviewerPass: true, // an uncovered criterion would block the run; this test is about step statuses
      complexitySignal: { ...complexitySignal, taskCount: 3 },
      toolExecutors: { default: (ctx: { currentTaskId?: string }) => { runs.push(ctx.currentTaskId ?? '?'); return `output for ${ctx.currentTaskId}` } },
      semanticTaskCompletion: async ({ taskDescription }) => (taskDescription === 'Step c' ? { done: false, reason: 'nothing real was produced' } : { done: true }),
    })
    const statuses = Object.fromEntries((outcome.result?.initResult.taskGraph.tasks ?? []).map((tk: Task) => [tk.id, tk.status]))
    expect(runs.filter((id) => id === 'a')).toHaveLength(1)
    expect(runs.filter((id) => id === 'b')).toHaveLength(1)
    expect(statuses.a).toBe('COMPLETE')
    expect(statuses.b).toBe('COMPLETE')
    expect(statuses.c).not.toBe('COMPLETE')
  })

  it('an uncovered success criterion that merely mentions a step\'s id does not reopen and re-run that finished step', async () => {
    // The criterion text says "a schedule is in place", and one finished step happens to have the id
    // "schedule". The reviewer's "criterion not covered" finding quotes that text; it must not be read as
    // pointing at the step.
    const mk = (id: string, deps: string[]): Task => ({ ...task, id, description: `Step ${id}`, depends_on: deps })
    const runs: string[] = []
    const outcome: any = await new HarnessRuntime().run('run the plan', ['scope agreed and a schedule is in place'], {
      initialTasks: [mk('scope', []), mk('schedule', ['scope']), mk('kickoff', ['schedule'])],
      max_steps: 30,
      complexitySignal: { ...complexitySignal, taskCount: 3 },
      toolExecutors: { default: (ctx: { currentTaskId?: string }) => { runs.push(ctx.currentTaskId ?? '?'); return `output for ${ctx.currentTaskId}` } },
      semanticCriterionCoverage: async () => false,
    })
    expect(outcome.status).toBe('complete')
    expect(runs).toEqual(['scope', 'schedule', 'kickoff'])
  })
})
