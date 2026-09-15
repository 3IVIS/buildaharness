import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type FsBackend, type MemoryAdapter } from '@buildaharness/runtime'
import {
  loadActivePlan,
  loadPlanRecord,
  createPlanRecord,
  createDraftPlanRecord,
  savePlan,
  abandonPlan,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  formatPlanProgress,
  matchTaskCancelAttempt,
  cancelPlanTask,
  editPlanTask,
  migratePlanRecord,
  type PlanRecord,
  type PlanFsPersistence,
} from './plan-store.js'
import type { Plan } from './plan-builder.js'

/** In-memory FsBackend with a working `rename`, standing in for a real disk. */
function makeFakeFsBackend(): FsBackend & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {},
    async readDir() {
      return []
    },
    async rename(from, to) {
      const contents = files.get(from)
      if (contents === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, contents)
    },
  }
}

function makeFsPersistence(): PlanFsPersistence & { backend: FsBackend & { files: Map<string, string> } } {
  return { backend: makeFakeFsBackend(), workspaceRoot: '/workspace' }
}

function makePlan(): Plan {
  return {
    templateName: 'project_planning',
    successCriteria: 'The launch ships on time.',
    tasks: [
      { id: 't1', description: 'Gather requirements', depends_on: [], riskLevel: 'LOW' },
      { id: 't2', description: 'Build the thing', depends_on: ['t1'], riskLevel: 'LOW' },
      { id: 't3', description: 'Ship it', depends_on: ['t2'], riskLevel: 'LOW' },
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

  it('migrates and resumes a pre-P0 legacy record persisted with `status` instead of `mode`', async () => {
    const memory = new InMemoryAdapter()
    const legacy = {
      templateName: 'project_planning',
      successCriteria: 'The launch ships on time.',
      tasks: [{ id: 't1', description: 'Gather requirements', depends_on: [], status: 'PENDING' as const }],
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await memory.set('plan:session-1', legacy)

    const loaded = await loadActivePlan(memory, 'session-1')
    expect(loaded?.mode).toBe('active')
    expect(loaded?.executingOnPlan).toBe(true)
    expect(loaded?.rationale).toBe('')
  })

  it('does not resume a plan still in drafting or awaiting_approval (plan mode, not yet wired to any producer)', async () => {
    const memory = new InMemoryAdapter()
    const drafting: PlanRecord = { ...createPlanRecord(makePlan()), mode: 'drafting' }
    await savePlan(memory, 'session-1', drafting)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })
})

describe('migratePlanRecord', () => {
  it('maps a legacy status straight across to mode, unchanged, without demoting executingOnPlan for a non-active plan', () => {
    const legacy = {
      templateName: 'project_planning',
      successCriteria: 'y',
      tasks: [],
      status: 'abandoned' as const,
      createdAt: '',
      updatedAt: '',
    }
    const migrated = migratePlanRecord(legacy)
    expect(migrated.mode).toBe('abandoned')
    expect(migrated.executingOnPlan).toBe(false)
  })

  it('passes a current-shape record through unchanged', () => {
    const record = createPlanRecord(makePlan())
    expect(migratePlanRecord(record)).toEqual(record)
  })
})

describe('createPlanRecord', () => {
  it('starts every task as PENDING and the plan as active', () => {
    const record = createPlanRecord(makePlan())
    expect(record.mode).toBe('active')
    expect(record.executingOnPlan).toBe(true)
    expect(record.tasks.every((t) => t.status === 'PENDING')).toBe(true)
    expect(record.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('defaults rationale to empty string when the source Plan has none', () => {
    const record = createPlanRecord(makePlan())
    expect(record.rationale).toBe('')
  })

  it('carries a Plan-supplied rationale through', () => {
    const record = createPlanRecord({ ...makePlan(), rationale: 'Because X depends on Y being done first.' })
    expect(record.rationale).toBe('Because X depends on Y being done first.')
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
    expect(updated.mode).toBe('active')
  })

  it('flips mode to done once every task is COMPLETE', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))

    expect(updated.mode).toBe('done')
  })

  // INV-32 (plan mode's P4): executingOnPlan flips back to false only once planCompletionPct
  // reaches 100 (all tasks COMPLETE) or on an explicit user abort (abandonPlan, tested below) —
  // never as a side effect of an error, a paused turn, or an in-progress task resolving.
  it('flips executingOnPlan to false in the same allComplete branch that flips mode to done (INV-32)', () => {
    const record = createPlanRecord(makePlan())
    expect(record.executingOnPlan).toBe(true)
    const updated = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))

    expect(updated.mode).toBe('done')
    expect(updated.executingOnPlan).toBe(false)
  })

  it('leaves executingOnPlan true while any task is still PENDING, RUNNING, or FAILED (INV-32 — no side-effect flip on a failed or in-progress task)', () => {
    const record = createPlanRecord(makePlan())
    const stillGoing = updatePlanFromRun(record, [
      { id: 't1', status: 'FAILED' },
      { id: 't2', status: 'PENDING' },
      { id: 't3', status: 'PENDING' },
    ])

    expect(stillGoing.mode).toBe('active')
    expect(stillGoing.executingOnPlan).toBe(true)
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
    expect(updated.mode).toBe('active')
  })
})

describe('abandonPlan', () => {
  // INV-32 (plan mode's P4): the other of exactly two places executingOnPlan flips back to
  // false — an explicit user abort, distinct from updatePlanFromRun's allComplete branch above.
  it('flips executingOnPlan to false alongside mode: abandoned', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    expect(record.executingOnPlan).toBe(true)
    await savePlan(memory, 'session-1', record)

    await abandonPlan(memory, 'session-1', record)

    const stored = await loadPlanRecord(memory, 'session-1')
    expect(stored?.mode).toBe('abandoned')
    expect(stored?.executingOnPlan).toBe(false)
  })
})

describe('planCompletionPct', () => {
  it('computes the percentage of COMPLETE tasks', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [{ id: 't1', status: 'COMPLETE' }])

    expect(planCompletionPct(updated)).toBeCloseTo(33.33, 1)
  })

  it('returns 0 for a plan with no tasks', () => {
    const empty: PlanRecord = { templateName: 'x', successCriteria: 'y', rationale: '', tasks: [], mode: 'active', executingOnPlan: true, createdAt: '', updatedAt: '' }
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
      { id: 'destination_research', description: 'Research the Kyoto destination', depends_on: [], riskLevel: 'LOW' },
      { id: 'book_transport', description: 'Book flights to Kyoto', depends_on: ['destination_research'], riskLevel: 'MEDIUM' },
      { id: 'itinerary_planning', description: 'Draft the daily-budget itinerary', depends_on: ['book_transport'], riskLevel: 'LOW' },
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
          riskLevel: 'LOW',
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
      tasks: [{ id: 'itinerary_planning', description: '起草每日预算行程', depends_on: [], riskLevel: 'LOW' }],
    })
    const match = matchTaskCancelAttempt('cancel the 每日预算 task for now', plan)
    expect(match).toEqual({ taskId: 'itinerary_planning', taskDescription: '起草每日预算行程' })
  })

  // Chinese (Simplified) cases — see plans/personal_assistant_chinese_lexical_checks_plan.html's
  // Phase 3 step 4. The task above already regression-tests the ASCII-only tokenizer fix (an
  // English verb/marker against a CJK task description); these additionally exercise a
  // fully-Chinese cancel verb and reference marker. Caveat: phrasing here is a first pass, not
  // verified by a fluent Chinese speaker.
  it('matches a fully-Chinese cancel-shaped request referencing a distinctive word from one task', () => {
    const plan = createPlanRecord({
      templateName: 'trip_planning',
      successCriteria: 'The trip is booked and planned.',
      tasks: [{ id: 'itinerary_planning', description: '起草每日预算行程', depends_on: [], riskLevel: 'LOW' }],
    })
    const match = matchTaskCancelAttempt('取消每日预算这个任务吧', plan)
    expect(match).toEqual({ taskId: 'itinerary_planning', taskDescription: '起草每日预算行程' })
  })

  it('returns null for a fully-Chinese cancel-shaped request unrelated to any task in the plan', () => {
    const plan = makeTripPlan()
    expect(matchTaskCancelAttempt('取消我的健身房会员', plan)).toBeNull()
  })

  it('returns null for Chinese input when there is no cancel-shaped verb at all', () => {
    const plan = makeTripPlan()
    expect(matchTaskCancelAttempt('每日预算是多少?', plan)).toBeNull()
  })

  it('does not hijack a genuine external Chinese cancel request that merely shares a word with a task description', () => {
    const plan = createPlanRecord({
      templateName: 'trip_planning',
      successCriteria: 'The trip is booked and planned.',
      tasks: [
        {
          id: 'logistics_prep',
          description: '旅行物流:购买旅行保险、确认护照签证有效性、准备打包清单',
          depends_on: [],
          riskLevel: 'LOW',
        },
      ],
    })
    // No explicit 任务/步骤/项/那部分/这部分/计划 reference — falls through to the ordinary
    // message-level risk gate, same as the English equivalent above.
    expect(matchTaskCancelAttempt('取消我的旅行保险,我找到了更便宜的。', plan)).toBeNull()
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
    expect(updated.mode).toBe('active')
    expect(updated.tasks.find((t) => t.id === 'destination_research')!.cancelled).toBeFalsy()
    expect(await loadActivePlan(memory, 'session-1')).toEqual(updated)
  })

  it('changes a task description without marking it complete', async () => {
    const memory = new InMemoryAdapter()
    const plan = makeTripPlan()
    await savePlan(memory, 'session-1', plan)

    const updated = await editPlanTask(memory, 'session-1', plan, 'itinerary_planning', 'Draft the daily-budget itinerary, in yen')

    const editedTask = updated.tasks.find((t) => t.id === 'itinerary_planning')!
    expect(editedTask.description).toBe('Draft the daily-budget itinerary, in yen')
    expect(editedTask.status).toBe('PENDING')
    expect(editedTask.cancelled).toBeFalsy()
    expect(updated.tasks.find((t) => t.id === 'destination_research')!.description).toBe('Research the Kyoto destination')
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

describe('createDraftPlanRecord', () => {
  it('starts in mode "drafting" with executingOnPlan false and no tasks', () => {
    const draft = createDraftPlanRecord(null)
    expect(draft.mode).toBe('drafting')
    expect(draft.executingOnPlan).toBe(false)
    expect(draft.tasks).toEqual([])
    expect(draft.templateName).toBeNull()
  })

  it('carries a seed templateName through when given one', () => {
    const draft = createDraftPlanRecord('project_planning')
    expect(draft.templateName).toBe('project_planning')
  })
})

describe('loadPlanRecord', () => {
  it('returns null when no plan exists for the session', async () => {
    const memory = new InMemoryAdapter()
    expect(await loadPlanRecord(memory, 'session-1')).toBeNull()
  })

  it('returns a drafting-mode record — unlike loadActivePlan, which would return null for it', async () => {
    const memory = new InMemoryAdapter()
    const draft = createDraftPlanRecord(null)
    await savePlan(memory, 'session-1', draft)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
    expect((await loadPlanRecord(memory, 'session-1'))?.mode).toBe('drafting')
  })

  it('returns an active record too, same as loadActivePlan', async () => {
    const memory = new InMemoryAdapter()
    const plan = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', plan)
    expect((await loadPlanRecord(memory, 'session-1'))?.mode).toBe('active')
  })
})

describe('P5 file-backed plan persistence', () => {
  it('mirrors a savePlan to <workspaceRoot>/.buildaharness/plans/<sessionId>.plan.json and a sibling .plan.md', async () => {
    const memory = new InMemoryAdapter()
    const fs = makeFsPersistence()
    const plan = createPlanRecord(makePlan())

    await savePlan(memory, 'session-1', plan, fs)

    const jsonRaw = fs.backend.files.get('/workspace/.buildaharness/plans/session-1.plan.json')
    expect(jsonRaw).toBeDefined()
    expect(JSON.parse(jsonRaw!)).toEqual(plan)

    const mdRaw = fs.backend.files.get('/workspace/.buildaharness/plans/session-1.plan.md')
    expect(mdRaw).toBeDefined()
    expect(mdRaw).toContain('not re-parsed if hand-edited')
    expect(mdRaw).toContain('Gather requirements')

    // No stray .tmp-* files left behind once the write-tmp-then-rename sequence completes.
    for (const path of fs.backend.files.keys()) expect(path).not.toContain('.tmp-')
  })

  it('sanitizes sessionId so it cannot escape the plans directory via path traversal', async () => {
    const memory = new InMemoryAdapter()
    const fs = makeFsPersistence()
    const plan = createPlanRecord(makePlan())

    await savePlan(memory, '../../etc/passwd', plan, fs)

    expect([...fs.backend.files.keys()].every((p) => p.startsWith('/workspace/.buildaharness/plans/'))).toBe(true)
  })

  it('reflects a hand-edited plan JSON file on the next load (the file is the editable-and-reloadable artifact)', async () => {
    const memory = new InMemoryAdapter()
    const fs = makeFsPersistence()
    const plan = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', plan, fs)

    // Simulate a user hand-editing the JSON file between turns: drop task t3 and reword t1.
    const path = '/workspace/.buildaharness/plans/session-1.plan.json'
    const handEdited: PlanRecord = {
      ...plan,
      tasks: plan.tasks.filter((t) => t.id !== 't3').map((t) => (t.id === 't1' ? { ...t, description: 'Gather requirements (edited by hand)' } : t)),
    }
    fs.backend.files.set(path, JSON.stringify(handEdited))

    const reloaded = await loadPlanRecord(memory, 'session-1', fs)
    expect(reloaded?.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(reloaded?.tasks[0].description).toBe('Gather requirements (edited by hand)')

    // Reconciled back into Dexie/State-tier too, not just returned in-memory for this one call.
    expect(((await memory.get('plan:session-1')) as PlanRecord).tasks.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('INV-33: a fs write that fails mid-sequence (rename never lands) leaves the old file+Dexie pair consistent, reconciled on next load', async () => {
    const memory = new InMemoryAdapter()
    const fs = makeFsPersistence()
    const original = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', original, fs)

    // Simulate a crash between the tmp write and the rename: the next save's rename never lands.
    const realRename = fs.backend.rename!.bind(fs.backend)
    fs.backend.rename = async () => {
      throw new Error('simulated crash before rename completed')
    }
    const edited = editPlanTaskShape(original)
    await expect(savePlan(memory, 'session-1', edited, fs)).resolves.toBeUndefined() // writePlanFiles swallows the error

    // Old file is still intact (rename never happened) — but Dexie was written through as `edited`
    // by savePlan's second step, so right after the failed write the two are split...
    expect(JSON.parse(fs.backend.files.get('/workspace/.buildaharness/plans/session-1.plan.json')!)).toEqual(original)
    expect(await memory.get('plan:session-1')).toEqual(edited)

    // ...but the very next load reconciles them to a single consistent state: the old fs version,
    // written back through to Dexie — never a load that returns a mix of the two.
    fs.backend.rename = realRename
    const reloaded = await loadPlanRecord(memory, 'session-1', fs)
    expect(reloaded).toEqual(original)
    expect(await memory.get('plan:session-1')).toEqual(original)
  })

  it('INV-33: a Dexie write that fails after the fs file already landed reconciles to the new state on next load', async () => {
    const memory = new InMemoryAdapter()
    const failingMemory: MemoryAdapter = {
      get: (key) => memory.get(key),
      set: async () => {
        throw new Error('simulated crash before Dexie write completed')
      },
      search: (query, topK, minScore) => memory.search(query, topK, minScore),
      delete: (key) => memory.delete(key),
    }
    const fs = makeFsPersistence()
    const original = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', original, fs)

    const edited = editPlanTaskShape(original)
    await expect(savePlan(failingMemory, 'session-1', edited, fs)).rejects.toThrow('simulated crash')

    // The fs file already reflects the new version (it's written before Dexie); Dexie itself
    // never got the new value at all since its own write is what "crashed".
    expect(JSON.parse(fs.backend.files.get('/workspace/.buildaharness/plans/session-1.plan.json')!)).toEqual(edited)
    expect(await memory.get('plan:session-1')).toEqual(original)

    // The next load (through the real, working memory adapter) resolves to the new version and
    // reconciles Dexie to match — never stuck on the old value forever.
    const reloaded = await loadPlanRecord(memory, 'session-1', fs)
    expect(reloaded).toEqual(edited)
    expect(await memory.get('plan:session-1')).toEqual(edited)
  })
})

function editPlanTaskShape(plan: PlanRecord): PlanRecord {
  return { ...plan, tasks: plan.tasks.map((t) => (t.id === 't1' ? { ...t, description: 'Gather requirements v2' } : t)), updatedAt: new Date().toISOString() }
}
