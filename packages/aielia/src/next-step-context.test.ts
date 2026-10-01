import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@buildaharness/runtime'
import { buildNextStepContext, summarizeConversation, summarizeGoalGraph } from './next-step-context.js'
import type { GoalGraphRecord, GoalThread } from './goal-graph-store.js'

const now = new Date().toISOString()
function thread(overrides: Partial<GoalThread>): GoalThread {
  return { id: 't', status: 'READY', templateName: null, successCriteria: 'goal', rationale: 'r', tasks: [], mode: 'active', executingOnPlan: false, createdAt: now, updatedAt: now, ...overrides }
}
const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

describe('summarizeConversation', () => {
  const transcript = [msg('user', 'read staging'), msg('assistant', 'ttl 300'), msg('user', 'how many workers'), msg('assistant', '6')]

  it('drops the current exchange so it is not sent twice', () => {
    expect(summarizeConversation(transcript, { userMessage: 'how many workers' })).toEqual([
      { role: 'user', content: 'read staging' },
      { role: 'assistant', content: 'ttl 300' },
    ])
  })

  it('keeps everything when the transcript does not end with the current exchange', () => {
    expect(summarizeConversation(transcript)).toHaveLength(4)
    expect(summarizeConversation(transcript, { userMessage: 'something else' })).toHaveLength(4)
  })

  it('skips tool and empty messages, caps the count and clips long messages', () => {
    const long = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`))
    const out = summarizeConversation([msg('tool', 'x'), msg('user', '  '), ...long, msg('user', 'y'.repeat(900))])
    expect(out).toHaveLength(8)
    expect(out.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(out[out.length - 1].content.length).toBeLessThanOrEqual(501)
  })
})

describe('summarizeGoalGraph', () => {
  const record: GoalGraphRecord = {
    threads: [
      thread({ id: 'a', status: 'DONE', successCriteria: 'finished goal', tasks: [{ id: '1', description: 'do it', depends_on: [], status: 'COMPLETE' }] }),
      thread({ id: 'b', status: 'READY', successCriteria: 'open goal' }),
      thread({ id: 'c', status: 'ABANDONED', successCriteria: 'dropped goal' }),
      thread({ id: 'd', status: 'ACTIVE', successCriteria: 'current goal', tasks: [{ id: '2', description: 'cancelled', depends_on: [], status: 'PENDING', cancelled: true }] }),
    ],
    activeThreadId: 'd',
    updatedAt: now,
  } as GoalGraphRecord

  it('carries a finished goal\'s persisted suggestions as openSuggestions, but not for the focus goal and not when there are none', () => {
    const sg = (description: string, confidence: 'high' | 'medium' = 'high') => ({ description, rationale: 'r', confidence }) as never
    const withSuggestions: GoalGraphRecord = {
      threads: [
        thread({ id: 'a', status: 'DONE', successCriteria: 'release status', suggestions: [sg('chase the sign-off'), sg('run the dry-run', 'medium'), sg('fix flaky test'), sg('a fourth one')] }),
        thread({ id: 'b', status: 'DONE', successCriteria: 'focus goal', suggestions: [sg('would duplicate the focus')] }),
        thread({ id: 'c', status: 'DONE', successCriteria: 'no suggestions' }),
      ],
      activeThreadId: 'b',
      updatedAt: now,
    } as GoalGraphRecord
    const out = summarizeGoalGraph(withSuggestions, 'b')
    expect(out.find((g) => g.goal === 'release status')?.openSuggestions).toEqual(['chase the sign-off', 'run the dry-run', 'fix flaky test'])
    expect(out.find((g) => g.goal === 'focus goal')).not.toHaveProperty('openSuggestions')
    expect(out.find((g) => g.goal === 'no suggestions')).not.toHaveProperty('openSuggestions')
  })

  it('leaves out abandoned goals and orders focus, then unfinished, then done', () => {
    expect(summarizeGoalGraph(record, 'a').map((g) => g.goal)).toEqual(['finished goal', 'current goal', 'open goal'])
    expect(summarizeGoalGraph(record, 'd').map((g) => g.goal)).toEqual(['current goal', 'open goal', 'finished goal'])
  })

  it('marks the focus thread, lists its tasks and skips cancelled tasks', () => {
    const out = summarizeGoalGraph(record, 'a')
    expect(out[0]).toMatchObject({ focus: true, tasks: [{ description: 'do it', status: 'COMPLETE' }] })
    expect(out.find((g) => g.goal === 'current goal')?.tasks).toEqual([])
  })

  it('is empty without a record', () => {
    expect(summarizeGoalGraph(undefined)).toEqual([])
  })
})

describe('buildNextStepContext', () => {
  it('omits every part that has nothing in it', () => {
    expect(buildNextStepContext({})).toEqual({ conversation: undefined, goals: undefined, stepsThisTurn: undefined })
  })

  it('lists the steps taken this turn', () => {
    expect(buildNextStepContext({ sources: [{ tool: 'read_file', path: 'config/staging.yaml' }] }).stepsThisTurn).toEqual(['read_file config/staging.yaml'])
  })
})
