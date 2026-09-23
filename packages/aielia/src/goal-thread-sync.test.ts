import { describe, it, expect } from 'vitest'
import { createGoalThreadFromPlanRecord, addThreadSuggestions, GoalThreadSchema, type GoalGraphRecord, type ThreadSuggestion } from './goal-graph-store.js'
import { syncThreadFromTaskGraph, focusThread, startThread, selectActiveThread } from './goal-thread-scheduler.js'
import { readyThreads } from './goal-graph-store.js'
import { createPlanRecord } from './plan-store.js'
import type { Plan } from './plan-builder.js'

function makeRecord(taskCount = 2): GoalGraphRecord {
  const plan: Plan = {
    templateName: 'trip_planning',
    successCriteria: 'Book a trip to Portugal.',
    tasks: Array.from({ length: taskCount }, (_, i) => ({ id: `t${i + 1}`, description: `step ${i + 1}`, depends_on: [], riskLevel: 'LOW' as const })),
  }
  const thread = createGoalThreadFromPlanRecord(createPlanRecord(plan), 'thread-1')
  return { threads: [thread], activeThreadId: 'thread-1', createdAt: thread.createdAt, updatedAt: thread.updatedAt }
}

const suggestion = (overrides: Partial<ThreadSuggestion> = {}): ThreadSuggestion => ({
  id: 's1',
  description: 'add tests for the login page',
  rationale: 'tests were named as pending',
  confidence: 'high',
  promotion: 'auto',
  createdAt: new Date().toISOString(),
  ...overrides,
})

describe('syncThreadFromTaskGraph — the transition to DONE', () => {
  it('marks the thread DONE (status and mode) once every task is COMPLETE', () => {
    const out = syncThreadFromTaskGraph(makeRecord(), 'thread-1', [{ id: 't1', status: 'COMPLETE' }, { id: 't2', status: 'COMPLETE' }])
    expect(out.threads[0].status).toBe('DONE')
    expect(out.threads[0].mode).toBe('done')
  })

  it('does not mark it DONE while any task is still pending, failed or blocked', () => {
    for (const other of ['PENDING', 'RUNNING', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED'] as const) {
      const out = syncThreadFromTaskGraph(makeRecord(), 'thread-1', [{ id: 't1', status: 'COMPLETE' }, { id: 't2', status: other }])
      expect(out.threads[0].status).not.toBe('DONE')
    }
  })

  it('ignores cancelled tasks when deciding, but needs at least one real task to complete', () => {
    const record = makeRecord()
    record.threads[0].tasks[1].cancelled = true
    expect(syncThreadFromTaskGraph(record, 'thread-1', [{ id: 't1', status: 'COMPLETE' }]).threads[0].status).toBe('DONE')

    const allCancelled = makeRecord()
    allCancelled.threads[0].tasks.forEach((t) => (t.cancelled = true))
    expect(syncThreadFromTaskGraph(allCancelled, 'thread-1', []).threads[0].status).not.toBe('DONE')
  })

  it('never marks a thread with no tasks DONE, and leaves ABANDONED/already-DONE threads alone', () => {
    expect(syncThreadFromTaskGraph(makeRecord(0), 'thread-1', []).threads[0].status).not.toBe('DONE')

    const abandoned = makeRecord()
    abandoned.threads[0].status = 'ABANDONED'
    expect(syncThreadFromTaskGraph(abandoned, 'thread-1', [{ id: 't1', status: 'COMPLETE' }, { id: 't2', status: 'COMPLETE' }]).threads[0].status).toBe('ABANDONED')
  })

  it('still lands evidence on a PAUSED thread (INV-42) and DONE is reached from there too', () => {
    const paused = makeRecord()
    paused.threads[0].status = 'PAUSED'
    const out = syncThreadFromTaskGraph(paused, 'thread-1', [{ id: 't1', status: 'COMPLETE' }, { id: 't2', status: 'COMPLETE' }])
    expect(out.threads[0].tasks.every((t) => t.status === 'COMPLETE')).toBe(true)
    expect(out.threads[0].status).toBe('DONE')
  })
})

describe('addThreadSuggestions', () => {
  it('persists high and medium confidence suggestions on the thread and the schema round-trips them', () => {
    const out = addThreadSuggestions(makeRecord(), 'thread-1', [suggestion(), suggestion({ id: 's2', description: 'deploy it', confidence: 'medium', promotion: 'pending_confirm' })])
    expect(out.threads[0].suggestions?.map((s) => s.description)).toEqual(['add tests for the login page', 'deploy it'])
    expect(GoalThreadSchema.parse(out.threads[0]).suggestions).toHaveLength(2)
  })

  it('drops session_only (low confidence) suggestions — advisory for the turn, never persisted', () => {
    const record = makeRecord()
    const out = addThreadSuggestions(record, 'thread-1', [suggestion({ confidence: 'low', promotion: 'session_only' })])
    expect(out).toBe(record)
  })

  it('does not stack a duplicate when proposing again for the same thread (case/whitespace-insensitive)', () => {
    const once = addThreadSuggestions(makeRecord(), 'thread-1', [suggestion()])
    const twice = addThreadSuggestions(once, 'thread-1', [suggestion({ id: 's9', description: '  Add tests for the login page ' })])
    expect(twice.threads[0].suggestions).toHaveLength(1)
  })

  it('is a no-op for an unknown thread id', () => {
    const record = makeRecord()
    expect(addThreadSuggestions(record, 'nope', [suggestion()]).threads[0].suggestions).toBeUndefined()
  })
})

describe('INV-40 — a thread still being drafted is never Scheduler-selectable', () => {
  it('readyThreads excludes drafting and awaiting_approval threads even though their status is READY', () => {
    const record = makeRecord()
    record.threads[0].status = 'READY'
    record.activeThreadId = null
    record.threads[0].mode = 'drafting'
    expect(readyThreads(record)).toEqual([])
    record.threads[0].mode = 'awaiting_approval'
    expect(readyThreads(record)).toEqual([])
    record.threads[0].mode = 'active'
    expect(readyThreads(record)).toHaveLength(1)
  })

  it('selectActiveThread does not hand focus to a drafting thread', () => {
    const record = makeRecord()
    record.threads[0].status = 'READY'
    record.threads[0].mode = 'drafting'
    record.activeThreadId = null
    expect(selectActiveThread(record).activeThreadId).toBeNull()
  })
})

describe('focusThread — the identity matcher\'s "this continues that goal"', () => {
  function twoThreads(): GoalGraphRecord {
    const a = makeRecord()
    const b = startThread(a, 'plan a birthday party').record // b ACTIVE, a PAUSED
    return b
  }

  it('promotes a PAUSED thread to ACTIVE and pauses the current one, keeping both intact (INV-38/42)', () => {
    const record = twoThreads()
    const paused = record.threads.find((t) => t.status === 'PAUSED')!
    const out = focusThread(record, paused.id)
    expect(out.switched).toBe(true)
    expect(out.record.threads.filter((t) => t.status === 'ACTIVE')).toHaveLength(1)
    expect(out.record.threads.find((t) => t.id === paused.id)?.status).toBe('ACTIVE')
    expect(out.record.activeThreadId).toBe(paused.id)
    expect(out.record.threads.find((t) => t.status === 'PAUSED')?.tasks).toBeDefined()
  })

  it('adopts a drafting placeholder: it becomes mode active because a real turn now runs it', () => {
    const record = twoThreads()
    const placeholder = record.threads.find((t) => t.status === 'PAUSED')!
    placeholder.status = 'READY'
    placeholder.mode = 'drafting'
    const out = focusThread(record, placeholder.id)
    expect(out.record.threads.find((t) => t.id === placeholder.id)).toMatchObject({ status: 'ACTIVE', mode: 'active' })
  })

  it('leaves a BLOCKED, DONE or ABANDONED thread exactly as it is', () => {
    for (const status of ['BLOCKED', 'DONE', 'ABANDONED'] as const) {
      const record = twoThreads()
      const target = record.threads.find((t) => t.status === 'PAUSED')!
      target.status = status
      const out = focusThread(record, target.id)
      expect(out.switched).toBe(false)
      expect(out.record.threads.find((t) => t.id === target.id)?.status).toBe(status)
    }
  })

  it('is a no-op for the already-active thread and for an unknown id', () => {
    const record = twoThreads()
    const active = record.threads.find((t) => t.status === 'ACTIVE')!
    expect(focusThread(record, active.id).switched).toBe(false)
    expect(focusThread(record, 'nope').switched).toBe(false)
  })
})

describe('startThread — a new goal takes focus', () => {
  it('creates an ACTIVE thread from the message (one short line), pausing the previous one as a concurrent sibling', () => {
    const record = makeRecord()
    const out = startThread(record, '  plan   my\nbirthday party  ')
    const fresh = out.record.threads.find((t) => t.id === out.activeThreadId)!
    expect(fresh).toMatchObject({ status: 'ACTIVE', mode: 'active', successCriteria: 'plan my birthday party', tasks: [], relationToSiblings: 'concurrent' })
    const old = out.record.threads.find((t) => t.id === 'thread-1')!
    expect(old.status).toBe('PAUSED')
    expect(old.siblingIds).toContain(fresh.id)
    expect(out.record.threads.filter((t) => t.status === 'ACTIVE')).toHaveLength(1)
  })

  it('starts the first thread with no sibling when nothing was active', () => {
    const out = startThread({ threads: [], activeThreadId: null, createdAt: 'x', updatedAt: 'x' }, 'do the thing')
    expect(out.record.threads).toHaveLength(1)
    expect(out.record.threads[0].relationToSiblings).toBeUndefined()
  })
})

describe('syncThreadFromTaskGraph — a thread with no tasks adopts the ones the harness ran', () => {
  it('adopts id/description/dependencies/risk and can then reach DONE', () => {
    const empty = startThread({ threads: [], activeThreadId: null, createdAt: 'x', updatedAt: 'x' }, 'do the thing').record
    const id = empty.threads[0].id
    const out = syncThreadFromTaskGraph(empty, id, [
      { id: 'a', status: 'COMPLETE', description: 'first', depends_on: [], risk_level: 'LOW' },
      { id: 'b', status: 'COMPLETE', description: 'second', depends_on: ['a'] },
    ])
    expect(out.threads[0].tasks.map((t) => [t.id, t.description, t.depends_on])).toEqual([['a', 'first', []], ['b', 'second', ['a']]])
    expect(out.threads[0].tasks[0].riskLevel).toBe('LOW')
    expect(out.threads[0].status).toBe('DONE')
  })

  it('does not adopt into a thread that already has tasks, or one still drafting', () => {
    const withTasks = syncThreadFromTaskGraph(makeRecord(), 'thread-1', [{ id: 'zzz', status: 'COMPLETE', description: 'stray' }])
    expect(withTasks.threads[0].tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    const drafting = startThread({ threads: [], activeThreadId: null, createdAt: 'x', updatedAt: 'x' }, 'x').record
    drafting.threads[0].mode = 'drafting'
    expect(syncThreadFromTaskGraph(drafting, drafting.threads[0].id, [{ id: 'a', status: 'COMPLETE' }]).threads[0].tasks).toEqual([])
  })
})
