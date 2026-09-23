import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type FsBackend } from '@buildaharness/runtime'
import {
  GoalGraphRecordSchema,
  GoalThreadSchema,
  createEmptyGoalGraphRecord,
  createGoalGraphRecordFromPlanRecord,
  createGoalThreadFromPlanRecord,
  loadGoalGraphRecord,
  saveGoalGraphRecord,
  getActiveThread,
  tasksForGoal,
  readyThreads,
  mintConcurrentReadyThread,
  abandonThread,
  type GoalGraphFsPersistence,
  type GoalGraphRecord,
} from './goal-graph-store.js'
import { createPlanRecord, savePlan, type PlanRecord } from './plan-store.js'
import type { Plan } from './plan-builder.js'

/** In-memory FsBackend with a working `rename`, standing in for a real disk — same fake as plan-store.test.ts. */
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

function makeFsPersistence(): GoalGraphFsPersistence & { backend: FsBackend & { files: Map<string, string> } } {
  return { backend: makeFakeFsBackend(), workspaceRoot: '/workspace' }
}

function makePlan(): Plan {
  return {
    templateName: 'project_planning',
    successCriteria: 'The launch ships on time.',
    tasks: [
      { id: 't1', description: 'Gather requirements', depends_on: [], riskLevel: 'LOW' },
      { id: 't2', description: 'Build the thing', depends_on: ['t1'], riskLevel: 'LOW' },
    ],
  }
}

function makeGoalGraphRecord(): GoalGraphRecord {
  const thread = createGoalThreadFromPlanRecord(createPlanRecord(makePlan()), 'thread-1')
  return { threads: [thread], activeThreadId: thread.id, createdAt: thread.createdAt, updatedAt: thread.updatedAt }
}

describe('GoalGraphRecordSchema', () => {
  it('accepts a freshly created empty record', () => {
    expect(() => GoalGraphRecordSchema.parse(createEmptyGoalGraphRecord())).not.toThrow()
  })

  it('accepts a record with a populated thread, including optional sibling-relation fields', () => {
    const record = makeGoalGraphRecord()
    const withSiblings: GoalGraphRecord = {
      ...record,
      threads: [{ ...record.threads[0], relationToSiblings: 'alternative', siblingIds: ['thread-2'] }],
    }
    expect(() => GoalGraphRecordSchema.parse(withSiblings)).not.toThrow()
  })

  it('rejects a thread with an invalid status', () => {
    const record = makeGoalGraphRecord()
    const bad = { ...record, threads: [{ ...record.threads[0], status: 'NOT_A_STATUS' }] }
    expect(() => GoalGraphRecordSchema.parse(bad)).toThrow()
  })

  it('rejects a thread missing required PlanRecord-absorbed fields (Q1 shape)', () => {
    const record = makeGoalGraphRecord()
    const { successCriteria: _drop, ...rest } = record.threads[0]
    const bad = { ...record, threads: [rest] }
    expect(() => GoalGraphRecordSchema.parse(bad)).toThrow()
  })

  it('round-trips a populated record through JSON.stringify/parse unchanged', () => {
    const record = makeGoalGraphRecord()
    const roundTripped = GoalGraphRecordSchema.parse(JSON.parse(JSON.stringify(record)))
    expect(roundTripped).toEqual(record)
  })
})

describe('createGoalThreadFromPlanRecord', () => {
  it('carries every PlanRecord field across unchanged (Q1: absorb, do not drop)', () => {
    const plan = createPlanRecord(makePlan())
    const thread = createGoalThreadFromPlanRecord(plan, 'thread-1')
    expect(thread.templateName).toBe(plan.templateName)
    expect(thread.successCriteria).toBe(plan.successCriteria)
    expect(thread.rationale).toBe(plan.rationale)
    expect(thread.mode).toBe(plan.mode)
    expect(thread.executingOnPlan).toBe(plan.executingOnPlan)
    expect(thread.createdAt).toBe(plan.createdAt)
    expect(thread.tasks.map((t) => t.id)).toEqual(plan.tasks.map((t) => t.id))
  })

  it('maps mode=active to status=ACTIVE', () => {
    const thread = createGoalThreadFromPlanRecord(createPlanRecord(makePlan()))
    expect(thread.status).toBe('ACTIVE')
  })

  it('maps mode=drafting/awaiting_approval to status=READY (never Scheduler-selectable mid-draft, INV-40)', () => {
    const plan = createPlanRecord(makePlan())
    expect(createGoalThreadFromPlanRecord({ ...plan, mode: 'drafting' }).status).toBe('READY')
    expect(createGoalThreadFromPlanRecord({ ...plan, mode: 'awaiting_approval' }).status).toBe('READY')
  })

  it('maps mode=done/abandoned straight across', () => {
    const plan = createPlanRecord(makePlan())
    expect(createGoalThreadFromPlanRecord({ ...plan, mode: 'done' }).status).toBe('DONE')
    expect(createGoalThreadFromPlanRecord({ ...plan, mode: 'abandoned' }).status).toBe('ABANDONED')
  })
})

describe('createGoalGraphRecordFromPlanRecord', () => {
  it('wraps the plan into exactly one thread and points activeThreadId at it when active', () => {
    const plan = createPlanRecord(makePlan())
    const record = createGoalGraphRecordFromPlanRecord(plan)
    expect(record.threads).toHaveLength(1)
    expect(record.activeThreadId).toBe(record.threads[0].id)
  })

  it('leaves activeThreadId null when the migrated plan is not active', () => {
    const plan: PlanRecord = { ...createPlanRecord(makePlan()), mode: 'done', executingOnPlan: false }
    const record = createGoalGraphRecordFromPlanRecord(plan)
    expect(record.activeThreadId).toBeNull()
  })
})

describe('loadGoalGraphRecord / saveGoalGraphRecord', () => {
  it('returns null when nothing exists for the session (no plan, no goal graph)', async () => {
    const memory = new InMemoryAdapter()
    expect(await loadGoalGraphRecord(memory, 'session-1')).toBeNull()
  })

  it('saves and reloads a record via the MemoryAdapter alone (Dexie-backed parity: no fsPersistence configured)', async () => {
    const memory = new InMemoryAdapter()
    const record = makeGoalGraphRecord()
    await saveGoalGraphRecord(memory, 'session-1', record)

    const loaded = await loadGoalGraphRecord(memory, 'session-1')
    expect(loaded).toEqual(record)
  })

  it('saves and reloads a record via the fs file, preferring it over the Dexie/State-tier copy', async () => {
    const memory = new InMemoryAdapter()
    const fsPersistence = makeFsPersistence()
    const record = makeGoalGraphRecord()
    await saveGoalGraphRecord(memory, 'session-1', record, fsPersistence)

    expect(fsPersistence.backend.files.size).toBeGreaterThan(0)

    // Simulate the fs file having been hand-edited between turns — the file must win on next load.
    const edited: GoalGraphRecord = { ...record, activeThreadId: null }
    for (const [path] of fsPersistence.backend.files) {
      await fsPersistence.backend.writeTextFile(path, JSON.stringify(edited, null, 2))
    }

    const loaded = await loadGoalGraphRecord(memory, 'session-1', fsPersistence)
    expect(loaded?.activeThreadId).toBeNull()
    // Reconciled back into memory (INV-33's discipline) so the two never stay silently split.
    expect(await memory.get('goalgraph:session-1')).toEqual(edited)
  })

  it('keys goal graphs by session, not globally', async () => {
    const memory = new InMemoryAdapter()
    await saveGoalGraphRecord(memory, 'session-1', makeGoalGraphRecord())
    expect(await loadGoalGraphRecord(memory, 'session-2')).toBeNull()
  })

  it('migrates a pre-existing PlanRecord into a single GoalThread on first load, never dropping its data', async () => {
    const memory = new InMemoryAdapter()
    const plan = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', plan)

    const migrated = await loadGoalGraphRecord(memory, 'session-1')
    expect(migrated?.threads).toHaveLength(1)
    expect(migrated?.threads[0].successCriteria).toBe(plan.successCriteria)
    expect(migrated?.threads[0].tasks.map((t) => t.id)).toEqual(plan.tasks.map((t) => t.id))
    expect(migrated?.threads[0].status).toBe('ACTIVE')
    expect(migrated?.activeThreadId).toBe(migrated?.threads[0].id)
  })

  it('persists the migrated goal graph so a second load reads it directly, not re-deriving from the legacy plan', async () => {
    const memory = new InMemoryAdapter()
    await savePlan(memory, 'session-1', createPlanRecord(makePlan()))

    const first = await loadGoalGraphRecord(memory, 'session-1')
    const second = await loadGoalGraphRecord(memory, 'session-1')
    expect(second).toEqual(first)
    expect(await memory.get('goalgraph:session-1')).toEqual(first)
  })

  it('migrates a pre-existing PlanRecord read from the fs file (P5-parity fs-backed legacy data)', async () => {
    const memory = new InMemoryAdapter()
    const fsPersistence = makeFsPersistence()
    const plan = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', plan, fsPersistence)

    const migrated = await loadGoalGraphRecord(memory, 'session-1', fsPersistence)
    expect(migrated?.threads[0].successCriteria).toBe(plan.successCriteria)
    expect(GoalThreadSchema.parse(migrated?.threads[0])).toEqual(migrated?.threads[0])
  })
})

// Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html — R2's locatability primitive
// (getActiveThread/tasksForGoal/readyThreads) and the NEW_GOAL/CANCEL_CURRENT mutation helpers
// (mintConcurrentReadyThread/abandonThread) becoming live.
describe('getActiveThread / tasksForGoal / readyThreads', () => {
  it('returns the thread activeThreadId points at, when its own status is genuinely ACTIVE', () => {
    const record = makeGoalGraphRecord()
    expect(getActiveThread(record)?.id).toBe('thread-1')
  })

  it('returns null when activeThreadId is null', () => {
    expect(getActiveThread(createEmptyGoalGraphRecord())).toBeNull()
  })

  it('returns null when the pointed-at thread is no longer ACTIVE (e.g. paused mid-transition, ahead of the Phase 5 Scheduler ever reassigning the pointer)', () => {
    const record = makeGoalGraphRecord()
    const paused: GoalGraphRecord = { ...record, threads: record.threads.map((t) => ({ ...t, status: 'PAUSED' })) }
    expect(getActiveThread(paused)).toBeNull()
  })

  it('tasksForGoal returns the given thread\'s own tasks by direct id lookup', () => {
    const record = makeGoalGraphRecord()
    expect(tasksForGoal(record, 'thread-1')).toEqual(record.threads[0].tasks)
    expect(tasksForGoal(record, 'no-such-thread')).toEqual([])
  })

  it('readyThreads filters to READY status only', () => {
    const record = makeGoalGraphRecord()
    const withExtra: GoalGraphRecord = { ...record, threads: [...record.threads, { ...record.threads[0], id: 'thread-2', status: 'READY' }] }
    expect(readyThreads(withExtra).map((t) => t.id)).toEqual(['thread-2'])
  })
})

describe('mintConcurrentReadyThread', () => {
  it('mints a new READY thread and pauses the given active thread, linking them as concurrent siblings', () => {
    const record = makeGoalGraphRecord()
    const updated = mintConcurrentReadyThread(record, 'book a flight to Lisbon', 'thread-1')

    expect(updated.threads).toHaveLength(2)
    const oldThread = updated.threads.find((t) => t.id === 'thread-1')
    const newThread = updated.threads.find((t) => t.id !== 'thread-1')
    expect(oldThread?.status).toBe('PAUSED')
    expect(oldThread?.relationToSiblings).toBe('concurrent')
    expect(oldThread?.siblingIds).toContain(newThread?.id)
    expect(newThread?.status).toBe('READY')
    expect(newThread?.relationToSiblings).toBe('concurrent')
    expect(newThread?.siblingIds).toEqual(['thread-1'])
    expect(newThread?.successCriteria).toBe('book a flight to Lisbon')
    expect(GoalThreadSchema.parse(newThread)).toEqual(newThread)
    // The old thread's task list/history is preserved, not reset — PAUSED keeps partial state.
    expect(oldThread?.tasks).toEqual(record.threads[0].tasks)
  })

  it('mints a standalone READY thread with no sibling linkage when there is nothing to pause', () => {
    const updated = mintConcurrentReadyThread(createEmptyGoalGraphRecord(), 'a fresh unrelated goal', null)
    expect(updated.threads).toHaveLength(1)
    expect(updated.threads[0].status).toBe('READY')
    expect(updated.threads[0].relationToSiblings).toBeUndefined()
    expect(updated.threads[0].siblingIds).toBeUndefined()
  })

  it('never writes activeThreadId — INV-39, Tier-1 is never the ACTIVE-pointer writer', () => {
    const record = makeGoalGraphRecord()
    const updated = mintConcurrentReadyThread(record, 'something else entirely', 'thread-1')
    expect(updated.activeThreadId).toBe(record.activeThreadId)
  })
})

describe('abandonThread', () => {
  it('marks the given thread ABANDONED, keeping it in the array for audit (never deleted)', () => {
    const record = makeGoalGraphRecord()
    const updated = abandonThread(record, 'thread-1')
    expect(updated.threads).toHaveLength(1)
    expect(updated.threads[0].status).toBe('ABANDONED')
    expect(updated.threads[0].id).toBe('thread-1')
  })

  it('leaves other threads untouched', () => {
    const record = makeGoalGraphRecord()
    const withExtra: GoalGraphRecord = { ...record, threads: [...record.threads, { ...record.threads[0], id: 'thread-2', status: 'READY' }] }
    const updated = abandonThread(withExtra, 'thread-1')
    expect(updated.threads.find((t) => t.id === 'thread-2')?.status).toBe('READY')
  })
})
