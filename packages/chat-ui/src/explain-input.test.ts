import { describe, it, expect } from 'vitest'
import { presentTurnResult, type AssistantTurnResult } from '@buildaharness/aielia'
import { explainInputFromEntries } from './explain-input'
import type { ChatEntry } from './types'

describe('explainInputFromEntries', () => {
  it('is empty before any turn', () => {
    expect(explainInputFromEntries([])).toEqual({ memoryInjection: undefined, planStatus: undefined })
  })

  it('explains the newest assistant reply, skipping user messages and earlier explanations', () => {
    const entries: ChatEntry[] = [
      { id: '1', kind: 'assistant', content: 'old', sources: [{ tool: 'read_file', path: 'old.md' }] as never },
      { id: '2', kind: 'assistant', content: 'new', sources: [{ tool: 'read_file', path: 'new.md' }] as never },
      { id: '3', kind: 'explain', command: '/why', lines: ['x'] },
      { id: '4', kind: 'user', content: '/sources' },
    ]
    expect(explainInputFromEntries(entries).sources).toEqual([{ tool: 'read_file', path: 'new.md' }])
  })

  it('gives a specific no-trace reason for a turn that ended before the harness ran', () => {
    const approval: ChatEntry = { id: '1', kind: 'approval', pendingMessage: 'rm', reason: 'r', resolution: 'denied' }
    expect(explainInputFromEntries([approval]).noTraceReason).toContain('declined')
    expect(explainInputFromEntries([{ ...approval, resolution: undefined }]).noTraceReason).toContain('waiting for your approval')
    expect(explainInputFromEntries([{ id: '2', kind: 'escalation', reason: 'stuck', pendingMessage: 'm' }]).noTraceReason).toContain('stuck')
  })

  it('prefers the live plan status over the one captured on the reply', () => {
    const entries: ChatEntry[] = [{ id: '1', kind: 'assistant', content: 'a', planStatus: { completionPct: 10 } as never }]
    expect(explainInputFromEntries(entries, { planStatus: { completionPct: 90 } as never }).planStatus?.completionPct).toBe(90)
  })

  it('hands the goal graph to the explainers (so /plan can say the request was worked as goal tasks)', () => {
    const goalGraph = { activeThreadId: null, threads: [] }
    expect(explainInputFromEntries([], { goalGraph }).goalGraph).toBe(goalGraph)
    expect(explainInputFromEntries([{ id: '1', kind: 'assistant', content: 'a' }], { goalGraph }).goalGraph).toBe(goalGraph)
  })

  describe('says the same thing as the shared presentation (and so as the CLI) for each outcome', () => {
    const turn = (over: Partial<AssistantTurnResult>): AssistantTurnResult => ({ status: 'ok', reply: null, ...over }) as AssistantTurnResult
    const reasonOf = (entry: ChatEntry): string | undefined => explainInputFromEntries([entry]).noTraceReason

    it('staged action waiting for approval, per kind', () => {
      for (const kind of ['write', 'shell', 'email', 'batch', 'revert'] as const) {
        const shown = presentTurnResult(turn({ status: 'needs_approval', pendingActionId: 'p', pendingActionKind: kind }))
        expect(reasonOf({ id: '1', kind: 'approval', pendingMessage: 'm', reason: 'r', pendingActionId: 'p', pendingActionKind: kind })).toBe(shown.noTraceReason)
      }
    })
    it('a resolved staged action names its kind and outcome', () => {
      expect(reasonOf({ id: '1', kind: 'approval', pendingMessage: 'm', reason: 'r', pendingActionId: 'p', pendingActionKind: 'shell', resolution: 'approved' })).toContain('staged shell command that was approved')
    })
    it('message-level approval, plan approval, clarification, escalation, stopped', () => {
      expect(reasonOf({ id: '1', kind: 'approval', pendingMessage: 'm', reason: 'r' })).toBe(presentTurnResult(turn({ status: 'needs_approval' })).noTraceReason)
      expect(reasonOf({ id: '1', kind: 'approval', pendingMessage: 'm', reason: 'r', resolution: 'denied' })).toContain('blocked on an approval gate and declined')
      expect(reasonOf({ id: '1', kind: 'plan_approval', pendingMessage: 'm', planApprovalId: 'x', planApproval: {} as never })).toBe(presentTurnResult(turn({ status: 'needs_plan_approval', planApprovalId: 'x' })).noTraceReason)
      expect(reasonOf({ id: '1', kind: 'clarification', pendingMessage: 'm', pendingClarificationId: 'c', questions: [] })).toBe(
        presentTurnResult(turn({ status: 'needs_clarification', pendingClarificationId: 'c', questions: [{ id: 'q' }] as never })).noTraceReason,
      )
      expect(reasonOf({ id: '1', kind: 'escalation', reason: 'budget', pendingMessage: 'm' })).toBe(presentTurnResult(turn({ status: 'escalated', reason: 'budget' })).noTraceReason)
      expect(reasonOf({ id: '1', kind: 'stopped' })).toBe(presentTurnResult(turn({ status: 'cancelled' })).noTraceReason)
    })
  })
})
