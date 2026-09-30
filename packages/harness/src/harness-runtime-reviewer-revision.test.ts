import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type ReviewerRevision } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// A reviewer finding that ACTS: at the end of a run the host may turn the pending verdict into a note; the last task to
// complete is reopened and runs once more. The pass's only finding in practice is "Success criterion not covered by any
// belief", so these tests use a criterion nothing will cover.

const task = (id: string, dependsOn: string[] = []): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: dependsOn,
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

const CRITERION = 'the migration is verified against production'

async function run(opts: {
  revision?: ReviewerRevision
  tasks?: Task[]
  criterion?: string
  isCheckableCriterion?: (c: string) => boolean
}) {
  const executed: string[] = []
  const notes: Array<{ taskId: string; note: string }> = []
  const verdicts: string[] = []
  const outcome = await new HarnessRuntime().run('do it', [opts.criterion ?? CRITERION], {
    initialTasks: opts.tasks ?? [task('t1')],
    max_steps: 20,
    toolExecutors: { default: (ctx) => { executed.push(ctx.currentTaskId ?? '?'); return { __harnessExecutionStatus: 'complete', output: `answer ${executed.length}` } } },
    reviewerRevision: opts.revision && ((v) => { verdicts.push(`${v.severity}:${v.lens}`); return opts.revision!(v) }),
    onReviewerRevision: (e) => notes.push(e),
    isCheckableCriterion: opts.isCheckableCriterion,
  })
  return { executed, notes, verdicts, outcome }
}

describe('reviewer revision', () => {
  it('without the hook nothing changes: the task runs once and the verdict is only a resolver input', async () => {
    const { executed, notes } = await run({})
    expect(executed).toEqual(['t1'])
    expect(notes).toEqual([])
  })

  it('a note from the host reopens the last completed task, which runs once more, and the note is delivered', async () => {
    const { executed, notes, verdicts } = await run({ revision: (v) => `review: ${v.summary}` })
    expect(verdicts[0]).toBe('MEDIUM:implementer')
    expect(executed).toEqual(['t1', 't1'])
    expect(notes).toEqual([{ taskId: 't1', note: `review: Success criterion not covered by any belief: "${CRITERION}"` }])
  })

  it('runs the reopened task exactly once more, whatever the second pass finds', async () => {
    const { executed, notes } = await run({ revision: () => 'again' })
    expect(executed).toEqual(['t1', 't1'])
    expect(notes).toHaveLength(1)
  })

  it('null (or blank) from the host means leave the answer alone', async () => {
    for (const revision of [() => null, () => '  '] as ReviewerRevision[]) {
      const { executed, notes } = await run({ revision })
      expect(executed).toEqual(['t1'])
      expect(notes).toEqual([])
    }
  })

  it('a throwing host is a no-op, not a failed run', async () => {
    const { executed, outcome } = await run({ revision: () => { throw new Error('boom') } })
    expect(outcome.status).toBe('complete')
    expect(executed).toEqual(['t1'])
  })

  it('is not offered while a task is still unfinished (the criterion is legitimately not met yet)', async () => {
    const tasks = [task('t1'), task('t2', ['t1'])]
    let offered = 0
    // t1 completes (so there IS a last completed task) but t2 fails, so the run ends with t2 unfinished
    const outcome = await new HarnessRuntime().run('do it', [CRITERION], {
      initialTasks: tasks,
      max_steps: 20,
      toolExecutors: { default: (ctx) => ({ __harnessExecutionStatus: ctx.currentTaskId === 't2' ? 'failed' : 'complete', output: 'x', error: 'no' }) },
      reviewerRevision: () => { offered++; return 'revise' },
    }).catch(() => ({ status: 'threw' }))
    expect(offered).toBe(0)
    void outcome
  })

  it('a criterion the host says is not checkable produces no finding, so there is nothing to act on', async () => {
    const { executed, verdicts, notes } = await run({ revision: () => 'revise', isCheckableCriterion: () => false })
    expect(verdicts).toEqual([])
    expect(executed).toEqual(['t1'])
    expect(notes).toEqual([])
  })

  it('with several tasks only the LAST to complete is reopened', async () => {
    const { executed } = await run({ revision: () => 'revise', tasks: [task('t1'), task('t2', ['t1']), task('t3', ['t2'])] })
    expect(executed).toEqual(['t1', 't2', 't3', 't3'])
  })
})
