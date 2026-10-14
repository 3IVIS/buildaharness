import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type FsBackend } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import type { AssistantTurnResult } from './assistant-types.js'
import { presentTurnResult, approvalLabels, NO_TRACE, DEFAULT_APPROVAL_REASON, DEFAULT_ESCALATION_REASON, DEFAULT_CLARIFICATION_REASON, MISSING_PLAN_APPROVAL_ID_REASON } from './turn-presentation.js'
import { FAST_PATH_REASON, explainPlan, NO_PLAN_TEXT, NO_DRAFTED_PLAN_BUT_GOAL_TASKS_TEXT } from './run-explain.js'
import type { GoalGraphState, GoalThreadView } from './goal-graph-service.js'

const result = (over: Partial<AssistantTurnResult>): AssistantTurnResult => ({ status: 'ok', reply: 'hi', ...over }) as AssistantTurnResult

describe('presentTurnResult', () => {
  it('ok: a reply with hints as data, and the fast-path reason for a harness-skipped turn', () => {
    const shown = presentTurnResult(
      result({
        riskLevel: 'MEDIUM',
        sources: [{ tool: 'read_file', path: 'a' }, { tool: 'read_file', path: 'b' }] as AssistantTurnResult['sources'],
        planStatus: { completionPct: 40 } as AssistantTurnResult['planStatus'],
        contradictionNotice: 'c',
        reviewNotice: 'r',
        auditNotice: 'a',
        pausedNote: 'p',
        nextSteps: [{ description: 'next' }] as AssistantTurnResult['nextSteps'],
        harnessSkipped: true,
      }),
    )
    expect(shown).toMatchObject({
      kind: 'reply',
      text: 'hi',
      riskLevel: 'MEDIUM',
      hints: { sourcesCount: 2, planCompletionPct: 40, contradictionNotice: 'c', reviewNotice: 'r', auditNotice: 'a', pausedNote: 'p' },
      noTraceReason: FAST_PATH_REASON,
    })
  })

  it('ok: no hints and no no-trace reason on a plain turn', () => {
    const shown = presentTurnResult(result({ sources: [], nextSteps: [] }))
    expect(shown).toMatchObject({ kind: 'reply', hints: { sourcesCount: undefined, planCompletionPct: undefined, nextSteps: undefined }, noTraceReason: undefined })
  })

  it('cancelled', () => {
    expect(presentTurnResult(result({ status: 'cancelled', reply: null }))).toEqual({ kind: 'cancelled', noTraceReason: NO_TRACE.stopped })
  })

  it.each([
    ['write', 'write', 'Apply this write?'],
    ['shell', 'shell command', 'Run this command?'],
    ['email', 'send email', 'Send this email?'],
    ['batch', 'batch research', 'Continue?'],
    ['revert', 'revert', 'Apply this revert?'],
  ] as const)('needs_approval with a staged %s action', (kind, kindLabel, promptText) => {
    const shown = presentTurnResult(result({ status: 'needs_approval', reply: null, reason: 'why', pendingActionId: 'p1', pendingActionKind: kind }))
    expect(shown).toMatchObject({ kind: 'approval', scope: 'action', reason: 'why', pendingActionId: 'p1', pendingActionKind: kind, kindLabel, promptText })
    expect(shown.noTraceReason).toBe(NO_TRACE.stagedAction(kindLabel))
  })

  it('needs_approval with no kind is a plain write, and with no id is the message-level gate', () => {
    expect(approvalLabels(undefined)).toEqual({ kindLabel: 'write', promptText: 'Apply this write?' })
    const shown = presentTurnResult(result({ status: 'needs_approval', reply: null, riskLevel: 'HIGH' }))
    expect(shown).toMatchObject({ kind: 'approval', scope: 'message', reason: DEFAULT_APPROVAL_REASON, riskLevel: 'HIGH' })
    expect(shown.noTraceReason).toBe(NO_TRACE.messageApproval())
  })

  it('needs_clarification with questions and an id is a clarification', () => {
    const questions = [{ id: 'q', question: 'which?' }] as AssistantTurnResult['questions']
    expect(presentTurnResult(result({ status: 'needs_clarification', reply: null, questions, pendingClarificationId: 'c1' }))).toMatchObject({ kind: 'clarification', pendingClarificationId: 'c1', questions })
  })

  it('needs_clarification without answerable questions falls back to an escalation with the reason', () => {
    const noId = presentTurnResult(result({ status: 'needs_clarification', reply: null, questions: [{ id: 'q' }] as AssistantTurnResult['questions'], reason: 'unclear' }))
    expect(noId).toMatchObject({ kind: 'escalation', reason: 'unclear' })
    expect(noId.noTraceReason).toBe(NO_TRACE.clarification('unclear'))
    const none = presentTurnResult(result({ status: 'needs_clarification', reply: null, questions: [], pendingClarificationId: 'c' }))
    expect(none).toMatchObject({ kind: 'escalation', reason: DEFAULT_CLARIFICATION_REASON })
    expect(none.noTraceReason).toContain('no further detail')
  })

  it('needs_plan_approval: a plan approval with its id, an escalation without one', () => {
    const planApproval = { tasks: [] } as unknown as AssistantTurnResult['planApproval']
    expect(presentTurnResult(result({ status: 'needs_plan_approval', reply: null, planApprovalId: 'pl', planApproval }))).toMatchObject({ kind: 'plan_approval', planApprovalId: 'pl', planApproval })
    expect(presentTurnResult(result({ status: 'needs_plan_approval', reply: null }))).toMatchObject({ kind: 'escalation', reason: MISSING_PLAN_APPROVAL_ID_REASON })
  })

  it('escalated: the reason, or the default, and a no-trace reason that names it', () => {
    expect(presentTurnResult(result({ status: 'escalated', reply: null, reason: 'budget' }))).toMatchObject({ kind: 'escalation', reason: 'budget', noTraceReason: NO_TRACE.escalated('budget') })
    expect(presentTurnResult(result({ status: 'escalated', reply: null }))).toMatchObject({ reason: DEFAULT_ESCALATION_REASON })
  })
})

describe('NO_TRACE', () => {
  it('words each resolution of an approval', () => {
    expect(NO_TRACE.stagedAction('shell command', 'approved')).toContain('staged shell command that was approved')
    expect(NO_TRACE.stagedAction('write', 'declined')).toContain('declined')
    expect(NO_TRACE.messageApproval('declined')).toContain('blocked on an approval gate and declined')
    expect(NO_TRACE.planApproval('declined')).toContain('plan that was declined')
    expect(NO_TRACE.planApproval(undefined, ' (pending /plan approve)')).toBe('No harness trace — the last turn staged a plan for approval (pending /plan approve).')
  })
})

describe('explainPlan: goal-task fallback (drift row 12)', () => {
  const thread = (total: number): GoalThreadView => ({ id: 't1', status: 'ACTIVE', visibility: 'fresh', successCriteria: 'ship it', tasks: { total, complete: 1, failed: 0, pending: total - 1 }, isActive: true, createdAt: '', updatedAt: '' }) as unknown as GoalThreadView
  const graph = (threads: GoalThreadView[]): GoalGraphState => ({ activeThreadId: 't1', threads })

  it('no plan and a thread with tasks gives the fallback text and the thread listing', () => {
    const lines = explainPlan({ goalGraph: graph([thread(3)]) })
    expect(lines[0]).toBe(NO_DRAFTED_PLAN_BUT_GOAL_TASKS_TEXT)
    expect(lines.join('\n')).toContain('ship it')
  })
  it('no plan and no tasks (or no goal data) still says no active plan', () => {
    expect(explainPlan({ goalGraph: graph([thread(0)]) })).toEqual([NO_PLAN_TEXT])
    expect(explainPlan({ goalGraph: graph([]) })).toEqual([NO_PLAN_TEXT])
    expect(explainPlan({})).toEqual([NO_PLAN_TEXT])
  })
})

// Moved from chat-ui's ask-question-render.test.ts when the card guard became presentTurnResult's clarification case.
// A REAL result: an unmocked PersonalAssistant halting on its step budget with ask mode on. The presentation is chosen
// from `{ status, questions, pendingClarificationId }` alone, so this proves the assistant's real output is renderable
// (the cases above use hand-built results).
describe('presentTurnResult on a genuine assistant result', () => {
  it('presents a real needs_clarification as a clarification whose question has options a card can show', async () => {
    const files = new Map([['/ws/note.txt', 'hello']])
    const backend: FsBackend = {
      async readTextFile(p) { return files.get(p) },
      async writeTextFile(p, c) { files.set(p, c) },
      async removeFile(p) { files.delete(p) },
      async mkdir() {},
      async readDir() { return ['note.txt'] },
    }
    const readNote = { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] }
    const assistant = new PersonalAssistant({
      llmClient: createScriptedLLMClient({ responses: [readNote, readNote, readNote, readNote, readNote, readNote, 'done'], streamChunks: ['done'] }),
      fileTools: { backend, workspaceRoot: '/ws' },
      checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'ui-real-ask' }),
      oneLoopMode: 'enabled',
      goalGraphSuggestMode: 'disabled',
      askMode: 'enabled',
      maxSteps: 2,
    })
    const result = await assistant.turn('Keep re-reading note.txt until you are certain of every word', { sessionId: 'ui' })
    expect(result.status).toBe('needs_clarification')
    const shown = presentTurnResult(result)
    expect(shown.kind).toBe('clarification')
    if (shown.kind !== 'clarification') return
    const q = shown.questions[0]
    expect(q.question.length).toBeGreaterThan(0)
    expect(q.options!.length).toBeGreaterThanOrEqual(2)
    expect(q.options!.every((o) => o.label.length > 0)).toBe(true)
  })
})
