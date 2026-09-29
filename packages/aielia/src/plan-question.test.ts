import { describe, it, expect } from 'vitest'
import { isPlanStuck, planQuestionRoutingMode, planTasksForRun, renderPlanStateBlock, renderPlanStopNote, shouldRoutePlanQuestion } from './plan-question.js'
import { createPlanRecord, type PlanRecord } from './plan-store.js'

const plan = createPlanRecord({
  templateName: 'project_planning',
  successCriteria: 'Scope is agreed and the launch is scheduled.',
  tasks: [
    { id: 't1', description: 'Define scope', depends_on: [], riskLevel: 'LOW' },
    { id: 't2', description: 'Build the schedule', depends_on: ['t1'], riskLevel: 'LOW' },
    { id: 't3', description: 'Hold kickoff', depends_on: ['t2'], riskLevel: 'LOW' },
  ],
})
const stuck: PlanRecord = {
  ...plan,
  tasks: [
    { ...plan.tasks[0], status: 'FAILED', statusNote: 'it only asked questions' },
    { ...plan.tasks[1], status: 'PENDING' },
    { ...plan.tasks[2], status: 'PENDING' },
  ],
}

describe('planQuestionRoutingMode', () => {
  it('defaults to stuck', () => {
    expect(planQuestionRoutingMode({})).toBe('stuck')
    expect(planQuestionRoutingMode({ AUDIT_PLAN_QUESTION_ROUTING: '' })).toBe('stuck')
    expect(planQuestionRoutingMode({ AUDIT_PLAN_QUESTION_ROUTING: 'stuck' })).toBe('stuck')
  })
  it('reads off and always', () => {
    for (const v of ['0', 'false', 'OFF', 'no', 'disabled']) expect(planQuestionRoutingMode({ AUDIT_PLAN_QUESTION_ROUTING: v })).toBe('off')
    for (const v of ['always', 'on', '1', 'true']) expect(planQuestionRoutingMode({ AUDIT_PLAN_QUESTION_ROUTING: v })).toBe('always')
  })
})

describe('isPlanStuck / shouldRoutePlanQuestion', () => {
  it('a plan is stuck only while a step is FAILED and not cancelled', () => {
    expect(isPlanStuck(plan)).toBe(false)
    expect(isPlanStuck(stuck)).toBe(true)
    expect(isPlanStuck({ ...stuck, tasks: [{ ...stuck.tasks[0], cancelled: true }, ...stuck.tasks.slice(1)] })).toBe(false)
  })

  it('stuck mode routes a question only on a stuck plan; always routes any; off never', () => {
    const q = (mode: 'off' | 'stuck' | 'always', p: PlanRecord | null, isPlanQuestion: boolean | undefined = true) => shouldRoutePlanQuestion({ mode, plan: p, isPlanQuestion })
    expect(q('stuck', stuck)).toBe(true)
    expect(q('stuck', plan)).toBe(false)
    expect(q('always', plan)).toBe(true)
    expect(q('off', stuck)).toBe(false)
  })

  it('never routes a message that is not a plan question, or when there is no plan', () => {
    expect(shouldRoutePlanQuestion({ mode: 'always', plan: stuck, isPlanQuestion: false })).toBe(false)
    expect(shouldRoutePlanQuestion({ mode: 'always', plan: stuck, isPlanQuestion: undefined })).toBe(false)
    expect(shouldRoutePlanQuestion({ mode: 'always', plan: null, isPlanQuestion: true })).toBe(false)
  })
})

describe('planTasksForRun', () => {
  it('puts a failed step back to pending and carries why it was rejected; leaves everything else alone', () => {
    const tasks = planTasksForRun(stuck.tasks)
    expect(tasks[0]).toMatchObject({ id: 't1', status: 'PENDING', description: 'Define scope (the previous attempt was not accepted: it only asked questions)' })
    expect(tasks[1]).toBe(stuck.tasks[1])
    expect(tasks[2]).toBe(stuck.tasks[2])
  })

  it('a failed step with no recorded reason is still retried', () => {
    const tasks = planTasksForRun([{ ...plan.tasks[0], status: 'FAILED' }])
    expect(tasks[0]).toMatchObject({ status: 'PENDING', description: 'Define scope (retrying a step that failed)' })
  })

  it('does not resurrect a cancelled step', () => {
    const cancelled = { ...plan.tasks[0], status: 'FAILED' as const, cancelled: true }
    expect(planTasksForRun([cancelled])[0]).toBe(cancelled)
  })

  it('does not modify the stored plan', () => {
    planTasksForRun(stuck.tasks)
    expect(stuck.tasks[0]).toMatchObject({ status: 'FAILED', description: 'Define scope' })
  })
})

describe('renderPlanStateBlock', () => {
  it('reports each step with its recorded status, the goal, progress, and the options when stuck', () => {
    const block = renderPlanStateBlock({ ...stuck, tasks: [{ ...stuck.tasks[0] }, { ...stuck.tasks[1], status: 'COMPLETE' }, stuck.tasks[2]] })
    expect(block).toContain('Plan goal (success criteria): Scope is agreed and the launch is scheduled.')
    expect(block).toContain('Progress: 1 of 3 steps done.')
    expect(block).toContain('- [FAILED] Define scope — not accepted because: it only asked questions')
    expect(block).toContain('- [done] Build the schedule')
    expect(block).toContain('- [not started] Hold kickoff')
    expect(block).toContain('retry it')
    expect(block).toContain('skip that step')
    expect(block).toContain('do not run or continue it')
  })

  it('offers no stuck options for a healthy plan, and excludes cancelled steps from progress', () => {
    const block = renderPlanStateBlock({ ...plan, tasks: [{ ...plan.tasks[0], status: 'COMPLETE' }, { ...plan.tasks[1], status: 'COMPLETE', cancelled: true }] })
    expect(block).not.toContain('retry it')
    expect(block).toContain('Progress: 1 of 1 steps done.')
    expect(block).toContain('- [cancelled] Build the schedule')
  })
})

describe('renderPlanStopNote', () => {
  it('names each rejected step and its reason, and the user\'s options', () => {
    const note = renderPlanStopNote(plan, { t2: 'no schedule was produced' })
    expect(note).toContain('I stopped the plan here: this step was not accepted as done.')
    expect(note).toContain('- Build the schedule: no schedule was produced')
    expect(note).toContain('retry it')
    expect(note).toContain('skip that step')
    expect(note).toContain('abandon the plan')
  })

  it('pluralises for more than one step', () => {
    expect(renderPlanStopNote(plan, { t2: 'a', t3: 'b' })).toContain('these steps were not accepted as done')
  })

  it('is empty when nothing was rejected, for a cancelled step, or for an id not in the plan', () => {
    expect(renderPlanStopNote(plan, undefined)).toBe('')
    expect(renderPlanStopNote(plan, {})).toBe('')
    expect(renderPlanStopNote(plan, { nope: 'x' })).toBe('')
    expect(renderPlanStopNote({ ...plan, tasks: [{ ...plan.tasks[1], cancelled: true }] }, { t2: 'x' })).toBe('')
  })
})
