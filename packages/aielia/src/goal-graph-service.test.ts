import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { createEmptyGoalGraphRecord, saveGoalGraphRecord, mintConcurrentReadyThread, type GoalGraphRecord, type GoalThread } from './goal-graph-store.js'
import { getGoalGraphState, classifyThreadVisibility } from './goal-graph-service.js'

function makeThread(overrides: Partial<GoalThread> = {}): GoalThread {
  const now = new Date().toISOString()
  return {
    id: 'thread-1',
    status: 'READY',
    templateName: null,
    successCriteria: 'Ship the launch.',
    rationale: 'The user asked for it.',
    tasks: [
      { id: 't1', description: 'Gather requirements', depends_on: [], status: 'COMPLETE' },
      { id: 't2', description: 'Build the thing', depends_on: ['t1'], status: 'RUNNING' },
      { id: 't3', description: 'Ship it', depends_on: ['t2'], status: 'FAILED' },
    ],
    mode: 'active',
    executingOnPlan: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('classifyThreadVisibility', () => {
  it('classifies a DONE thread as done regardless of mode', () => {
    expect(classifyThreadVisibility(makeThread({ status: 'DONE', mode: 'done' }))).toBe('done')
  })

  it('classifies a drafting thread as suggested-but-not-committed', () => {
    expect(classifyThreadVisibility(makeThread({ status: 'READY', mode: 'drafting' }))).toBe('suggested_not_committed')
  })

  it('classifies an untouched thread (createdAt === updatedAt) as freshly computed', () => {
    const now = new Date().toISOString()
    expect(classifyThreadVisibility(makeThread({ status: 'ACTIVE', mode: 'active', createdAt: now, updatedAt: now }))).toBe('freshly_computed')
  })

  it('classifies a thread updated since creation as carried over', () => {
    expect(
      classifyThreadVisibility(
        makeThread({ status: 'ACTIVE', mode: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }),
      ),
    ).toBe('carried_over')
  })
})

describe('getGoalGraphState', () => {
  it('returns an empty state when no goal graph exists for the session', async () => {
    const memory = new InMemoryAdapter()
    expect(await getGoalGraphState(memory, 'no-such-session')).toEqual({ activeThreadId: null, threads: [] })
  })

  it('projects every thread with its visibility bucket, task summary, and active flag', async () => {
    const memory = new InMemoryAdapter()
    const t1 = makeThread({ id: 't-active', status: 'ACTIVE', mode: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
    const t2 = makeThread({ id: 't-drafting', status: 'READY', mode: 'drafting', successCriteria: 'A new idea.', tasks: [] })
    const record: GoalGraphRecord = { threads: [t1, t2], activeThreadId: 't-active', createdAt: t1.createdAt, updatedAt: t1.updatedAt }
    await saveGoalGraphRecord(memory, 'sess', record)

    const state = await getGoalGraphState(memory, 'sess')
    expect(state.activeThreadId).toBe('t-active')
    expect(state.threads).toHaveLength(2)

    const activeView = state.threads.find((t) => t.id === 't-active')
    expect(activeView).toMatchObject({
      status: 'ACTIVE',
      visibility: 'carried_over',
      isActive: true,
      tasks: { total: 3, complete: 1, failed: 1, pending: 1 },
    })

    const draftingView = state.threads.find((t) => t.id === 't-drafting')
    expect(draftingView).toMatchObject({
      status: 'READY',
      visibility: 'suggested_not_committed',
      isActive: false,
      tasks: { total: 0, complete: 0, failed: 0, pending: 0 },
    })
  })

  it('never marks a non-ACTIVE-status thread as active even if it is activeThreadId (mirrors getActiveThread\'s own defensiveness)', async () => {
    const memory = new InMemoryAdapter()
    const paused = makeThread({ id: 't-paused', status: 'PAUSED', mode: 'active' })
    const record: GoalGraphRecord = { threads: [paused], activeThreadId: 't-paused', createdAt: paused.createdAt, updatedAt: paused.updatedAt }
    await saveGoalGraphRecord(memory, 'sess2', record)

    const state = await getGoalGraphState(memory, 'sess2')
    expect(state.threads[0].isActive).toBe(false)
  })

  it('surfaces a sibling relation minted by mintConcurrentReadyThread', async () => {
    const memory = new InMemoryAdapter()
    const base = createEmptyGoalGraphRecord()
    const withThread: GoalGraphRecord = { ...base, threads: [makeThread({ id: 'orig', status: 'ACTIVE' })] }
    const withNew = mintConcurrentReadyThread(withThread, 'A second, unrelated goal', 'orig')
    await saveGoalGraphRecord(memory, 'sess3', withNew)

    const state = await getGoalGraphState(memory, 'sess3')
    const orig = state.threads.find((t) => t.id === 'orig')
    expect(orig?.relationToSiblings).toBe('concurrent')
    expect(orig?.siblingIds?.length).toBe(1)
  })
})
