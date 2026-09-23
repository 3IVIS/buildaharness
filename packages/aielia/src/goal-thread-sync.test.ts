import { describe, it, expect } from 'vitest'
import { createGoalThreadFromPlanRecord, addThreadSuggestions, GoalThreadSchema, type GoalGraphRecord, type ThreadSuggestion } from './goal-graph-store.js'
import { syncThreadFromTaskGraph } from './goal-thread-scheduler.js'
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
