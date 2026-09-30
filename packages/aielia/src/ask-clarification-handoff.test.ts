import { describe, it, expect, vi } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { buildBudgetExhaustedQuestion } from '@buildaharness/harness'
import { AskClarificationService } from './ask-clarification-service.js'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// Answering a structured question used to resume the paused harness run with no proposer: under the default one-loop mode
// it could only return the stored draft reply — an empty string for a tool turn — so the user got silence after picking an
// option. In one-loop mode the validated answer is now handed to the ordinary turn pipeline.

const classification = {
  riskLevel: 'LOW', riskReason: 't', requiresApproval: false, isTrivial: false, decomposedTasks: null,
  isReminderRequest: false, isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null,
  needsMultiStepPlan: false, statesDurableFacts: [],
} as never

const q = buildBudgetExhaustedQuestion(3)
const answer = { answers: [{ questionId: q.id, kind: 'selected' as const, selectedLabels: [q.options![0].label] }] }

function fakes() {
  const memory = new InMemoryAdapter()
  const bridge = { run: vi.fn(async () => { throw new Error('the paused run must not be resumed in hand-off mode') }), discardPausedRun: vi.fn(async () => {}) }
  const session = { appendTranscriptMessage: vi.fn(async () => {}) }
  const service = new AskClarificationService(memory as never, session as never, bridge as never, {} as never, undefined)
  return { memory, bridge, service }
}

async function stage(service: AskClarificationService) {
  const result = await service.stageAndRespond({ sessionId: 's', transcriptKey: 'transcript:s', userMessage: 'read the notes', questions: [q], classification, activePlan: null, facts: [], draftReply: '' })
  return result.pendingClarificationId!
}

describe('AskClarificationService.resolvePendingClarification in hand-off mode', () => {
  it('validates the answer, discards the paused run, and returns the rendered answer to continue as an ordinary turn — without resuming the harness', async () => {
    const { service, bridge, memory } = fakes()
    const id = await stage(service)
    const out = await service.resolvePendingClarification('s', 'transcript:s', id, answer, true, true)
    expect(out).toEqual({ fallThrough: true, answerText: expect.stringContaining(`Answer to your question: ${q.question}`) })
    expect((out as { answerText: string }).answerText).toContain(q.options![0].label)
    expect(bridge.discardPausedRun).toHaveBeenCalledWith('s')
    expect(bridge.run).not.toHaveBeenCalled()
    expect(await memory.get(`ask-pending:${id}`)).toBeUndefined() // resolved once
  })

  it('still fails closed: no answer, or one that does not match the staged questions, is not handed off', async () => {
    const { service, bridge } = fakes()
    const id = await stage(service)
    const none = await service.resolvePendingClarification('s', 'transcript:s', id, undefined, true, true)
    expect(none).toMatchObject({ status: 'needs_clarification' })
    const wrong = await service.resolvePendingClarification('s', 'transcript:s', id, { answers: [{ questionId: 'nope', kind: 'free_text', freeText: 'x' }] }, true, true)
    expect(wrong).toMatchObject({ status: 'needs_clarification' })
    expect(bridge.discardPausedRun).not.toHaveBeenCalled()
  })

  it('outside hand-off mode (flat loop) the paused run is resumed as before', async () => {
    const { service, bridge } = fakes()
    const id = await stage(service)
    await expect(service.resolvePendingClarification('s', 'transcript:s', id, answer, true, false)).rejects.toThrow('must not be resumed')
    expect(bridge.run).toHaveBeenCalledTimes(1)
  })
})

describe('through PersonalAssistant (one-loop, the default)', () => {
  it('answering a staged question by ID continues as an ordinary turn: the model sees the answer and the user gets a reply, not silence', async () => {
    const inner = createScriptedLLMClient({ responses: ['The notice period is 90 days.'], streamChunks: ['The notice period is 90 days.'], classify: () => ({ isTrivial: false }) })
    const seen: ChatMessage[][] = []
    const llm: ILLMClient = {
      callChat: (m, o) => { seen.push(m); return inner.callChat(m, o) },
      callChatSync: (m, o) => { seen.push(m); return inner.callChatSync(m, o) },
      callChatStructured: async (m, t, o): Promise<LLMStructuredResponse> => { seen.push(m); return inner.callChatStructured(m, t, o) },
    }
    const assistant = new PersonalAssistant({ llmClient: llm, checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'c' }), oneLoopMode: 'enabled', askMode: 'enabled', goalGraphSuggestMode: 'disabled' })
    const staged = await (assistant as unknown as { askClarification: AskClarificationService }).askClarification.stageAndRespond({
      sessionId: 's', transcriptKey: 'transcript:s', userMessage: 'Read notes/vendor-terms.md and tell me the notice period.', questions: [q], classification, activePlan: null, facts: [], draftReply: '',
    })
    const result = await assistant.turn('Go with your best option.', { sessionId: 's', pendingClarificationId: staged.pendingClarificationId, clarificationAnswer: answer })
    expect(result.status).toBe('ok')
    expect(result.reply).toBe('The notice period is 90 days.')
    expect(seen.flat().some((m) => m.role === 'user' && m.content.includes(`Answer to your question: ${q.question}`))).toBe(true)
  })
})
