import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import {
  loadActivePlan,
  createPlanRecord,
  savePlan,
  abandonPlan,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  formatPlanProgress,
  matchTaskCancelAttempt,
  cancelPlanTask,
  type PlanRecord,
} from './plan-store.js'
import type { Plan } from './plan-builder.js'

function makePlan(): Plan {
  return {
    templateName: 'project_planning',
    successCriteria: 'The launch ships on time.',
    tasks: [
      { id: 't1', description: 'Gather requirements', depends_on: [] },
      { id: 't2', description: 'Build the thing', depends_on: ['t1'] },
      { id: 't3', description: 'Ship it', depends_on: ['t2'] },
    ],
  }
}

describe('loadActivePlan', () => {
  it('returns null when no plan exists for the session', async () => {
    const memory = new InMemoryAdapter()
    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('returns the stored record when it is active', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', record)

    const loaded = await loadActivePlan(memory, 'session-1')
    expect(loaded).toEqual(record)
  })

  it('returns null when the stored record is done', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    const done = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))
    await savePlan(memory, 'session-1', done)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('returns null when the stored record is abandoned', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', record)
    await abandonPlan(memory, 'session-1', record)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('keys plans by session, not globally', async () => {
    const memory = new InMemoryAdapter()
    await savePlan(memory, 'session-1', createPlanRecord(makePlan()))

    expect(await loadActivePlan(memory, 'session-2')).toBeNull()
  })
})

describe('createPlanRecord', () => {
  it('starts every task as PENDING and the plan as active', () => {
    const record = createPlanRecord(makePlan())
    expect(record.status).toBe('active')
    expect(record.tasks.every((t) => t.status === 'PENDING')).toBe(true)
    expect(record.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('updatePlanFromRun', () => {
  it('maps harness task statuses back onto the plan tasks by id', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [
      { id: 't1', status: 'COMPLETE' },
      { id: 't2', status: 'PENDING' },
      { id: 't3', status: 'PENDING' },
    ])

    expect(updated.tasks.find((t) => t.id === 't1')!.status).toBe('COMPLETE')
    expect(updated.tasks.find((t) => t.id === 't2')!.status).toBe('PENDING')
    expect(updated.status).toBe('active')
  })

  it('flips status to done once every task is COMPLETE', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))

    expect(updated.status).toBe('done')
  })

  it('leaves a task status unchanged if the harness result omits it', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [{ id: 't1', status: 'COMPLETE' }])

    expect(updated.tasks.find((t) => t.id === 't2')!.status).toBe('PENDING')
  })

  it('normalizes a task left RUNNING (step cap hit mid-task) back to PENDING, not stranding it', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [
      { id: 't1', status: 'RUNNING' },
      { id: 't2', status: 'PENDING' },
      { id: 't3', status: 'PENDING' },
    ])

    expect(updated.tasks.find((t) => t.id === 't1')!.status).toBe('PENDING')
    expect(updated.status).toBe('active')
  })
})

describe('planCompletionPct', () => {
  it('computes the percentage of COMPLETE tasks', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [{ id: 't1', status: 'COMPLETE' }])

    expect(planCompletionPct(updated)).toBeCloseTo(33.33, 1)
  })

  it('returns 0 for a plan with no tasks', () => {
    const empty: PlanRecord = { templateName: 'x', successCriteria: 'y', tasks: [], status: 'active', createdAt: '', updatedAt: '' }
    expect(planCompletionPct(empty)).toBe(0)
  })
})

describe('formatPlanProgress', () => {
  it('includes the template name, completion percentage, task lines, and success criteria', () => {
    const record = createPlanRecord(makePlan())
    const text = formatPlanProgress(record)

    expect(text).toContain('project_planning')
    expect(text).toContain('0.0% complete')
    expect(text).toContain('t1')
    expect(text).toContain('Gather requirements')
    expect(text).toContain('The launch ships on time.')
  })
})

function makeTripPlan(): PlanRecord {
  return createPlanRecord({
    templateName: 'trip_planning',
    successCriteria: 'The trip is booked and planned.',
    tasks: [
      { id: 'destination_research', description: 'Research the Kyoto destination', depends_on: [] },
      { id: 'book_transport', description: 'Book flights to Kyoto', depends_on: ['destination_research'] },
      { id: 'itinerary_planning', description: 'Draft the daily-budget itinerary', depends_on: ['book_transport'] },
    ],
  })
}

describe('matchTaskCancelAttempt (conv59/conv70 h9 finding)', () => {
  it('matches a cancel-shaped request referencing a distinctive word from one task', () => {
    const plan = makeTripPlan()
    const match = matchTaskCancelAttempt(
      "I don't want to cancel the trip, but can you cancel the daily-budget task for now?",
      plan,
    )
    expect(match).toEqual({ taskId: 'itinerary_planning', taskDescription: 'Draft the daily-budget itinerary' })
  })

  it('returns null for a cancel-shaped request unrelated to any task in the plan', () => {
    const plan = makeTripPlan()
    expect(matchTaskCancelAttempt('Please cancel my gym membership.', plan)).toBeNull()
  })

  it('returns null when there is no cancel-shaped verb at all', () => {
    const plan = makeTripPlan()
    expect(matchTaskCancelAttempt('What is the daily budget so far?', plan)).toBeNull()
  })

  it('does not match an already-COMPLETE or already-cancelled task', () => {
    const plan = makeTripPlan()
    const withOneComplete = updatePlanFromRun(plan, [{ id: 'destination_research', status: 'COMPLETE' }])
    // "Research the Kyoto destination" is COMPLETE — a cancel request referencing "destination"
    // should find nothing, since that task is already done, not cancellable.
    expect(matchTaskCancelAttempt('Cancel the destination step.', withOneComplete)).toBeNull()
  })

  it('does not hijack a genuine external cancel request that merely shares a word with a task description', () => {
    // h3/convE: a real "cancel my travel insurance policy" request coincidentally shares
    // "insurance"/"travel" with the plan's own "arrange travel insurance" logistics task, but
    // never references the plan/a task/step at all — must fall through to the ordinary
    // message-level risk gate instead of being silently absorbed as internal bookkeeping.
    const plan = createPlanRecord({
      templateName: 'trip_planning',
      successCriteria: 'The trip is booked and planned.',
      tasks: [
        {
          id: 'logistics_prep',
          description: 'travel logistics: arrange travel insurance, verify passport/visa validity, prepare packing list',
          depends_on: [],
        },
      ],
    })
    expect(
      matchTaskCancelAttempt('Actually, please cancel my travel insurance policy with my current provider - I found a much cheaper one elsewhere.', plan),
    ).toBeNull()
  })

  it('matches a task with a non-Latin-script description — regression for the ASCII-only `.split(/[^a-z0-9]+/)` tokenizer, which produced an empty word list for CJK text and silently disabled this feature entirely for it', () => {
    const plan = createPlanRecord({
      templateName: 'trip_planning',
      successCriteria: 'The trip is booked and planned.',
      tasks: [{ id: 'itinerary_planning', description: '起草每日预算行程', depends_on: [] }],
    })
    const match = matchTaskCancelAttempt('cancel the 每日预算 task for now', plan)
    expect(match).toEqual({ taskId: 'itinerary_planning', taskDescription: '起草每日预算行程' })
  })
})

describe('cancelPlanTask', () => {
  it('marks the task cancelled and COMPLETE, keeps the plan active, and leaves other tasks untouched', async () => {
    const memory = new InMemoryAdapter()
    const plan = makeTripPlan()
    await savePlan(memory, 'session-1', plan)

    const updated = await cancelPlanTask(memory, 'session-1', plan, 'itinerary_planning')

    const cancelledTask = updated.tasks.find((t) => t.id === 'itinerary_planning')!
    expect(cancelledTask.status).toBe('COMPLETE')
    expect(cancelledTask.cancelled).toBe(true)
    expect(updated.status).toBe('active')
    expect(updated.tasks.find((t) => t.id === 'destination_research')!.cancelled).toBeFalsy()
    expect(await loadActivePlan(memory, 'session-1')).toEqual(updated)
  })

  it('excludes a cancelled task from planCompletionPct instead of counting it as done', () => {
    const plan = makeTripPlan()
    const withOneComplete = updatePlanFromRun(plan, [{ id: 'destination_research', status: 'COMPLETE' }])
    const cancelled: PlanRecord = {
      ...withOneComplete,
      tasks: withOneComplete.tasks.map((t) => (t.id === 'book_transport' ? { ...t, status: 'COMPLETE', cancelled: true } : t)),
    }
    // 1 genuinely complete + 1 cancelled out of 3 — completion should be measured against the
    // 2 non-cancelled tasks (1/2 = 50%), not 2/3.
    expect(planCompletionPct(cancelled)).toBeCloseTo(50, 1)
  })

  it('shows a cancelled task distinctly in formatPlanProgress instead of claiming it was completed', () => {
    const plan = makeTripPlan()
    const cancelled: PlanRecord = {
      ...plan,
      tasks: plan.tasks.map((t) => (t.id === 'book_transport' ? { ...t, status: 'COMPLETE', cancelled: true } : t)),
    }
    const text = formatPlanProgress(cancelled)
    expect(text).toContain('CANCELLED')
    expect(text).toContain('Book flights to Kyoto')
  })
})

describe('computePlanPosition', () => {
  it('reports the first task before anything has started', () => {
    const plan = createPlanRecord(makePlan())
    const pos = computePlanPosition(plan, plan.tasks)
    expect(pos).toEqual({ templateName: 'project_planning', stepIndex: 1, stepCount: 3, currentTaskDescription: 'Gather requirements', completionPct: 0 })
  })

  it('reports the RUNNING task mid-run', () => {
    const plan = createPlanRecord(makePlan())
    const live = [
      { id: 't1', status: 'COMPLETE' as const },
      { id: 't2', status: 'RUNNING' as const },
      { id: 't3', status: 'PENDING' as const },
    ]
    const pos = computePlanPosition(plan, live)
    expect(pos?.stepIndex).toBe(2)
    expect(pos?.currentTaskDescription).toBe('Build the thing')
    expect(pos?.completionPct).toBeCloseTo(100 / 3)
  })

  it('falls back to the last COMPLETE task once nothing is RUNNING', () => {
    const plan = createPlanRecord(makePlan())
    const live = [
      { id: 't1', status: 'COMPLETE' as const },
      { id: 't2', status: 'COMPLETE' as const },
      { id: 't3', status: 'PENDING' as const },
    ]
    const pos = computePlanPosition(plan, live)
    expect(pos?.stepIndex).toBe(2)
    expect(pos?.currentTaskDescription).toBe('Build the thing')
    expect(pos?.completionPct).toBeCloseTo((2 / 3) * 100)
  })

  it('returns null for a plan with no tasks', () => {
    const plan: PlanRecord = { ...createPlanRecord(makePlan()), tasks: [] }
    expect(computePlanPosition(plan, [])).toBeNull()
  })
})

describe('nextPendingTask', () => {
  it('returns the first not-yet-COMPLETE task in plan order', () => {
    const plan = createPlanRecord(makePlan())
    plan.tasks[0].status = 'COMPLETE'
    expect(nextPendingTask(plan)?.id).toBe('t2')
  })

  it('returns null once every task is COMPLETE', () => {
    const plan = createPlanRecord(makePlan())
    for (const t of plan.tasks) t.status = 'COMPLETE'
    expect(nextPendingTask(plan)).toBeNull()
  })
})
