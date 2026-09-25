import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { checkRequestAmbiguity, parseAmbiguityCheck } from './ambiguity-guard.js'
import { TurnInterpreter } from './turn-interpreter.js'
import type { AmbiguityGuardMode } from './ambiguity-guard-flag.js'

describe('parseAmbiguityCheck', () => {
  it('parses an ambiguous verdict with its question', () => {
    expect(parseAmbiguityCheck('{"ambiguous": true, "question": " Older than which year? "}')).toEqual({ ambiguous: true, question: 'Older than which year?' })
  })
  it('treats an ambiguous verdict with no question as not ambiguous', () => {
    expect(parseAmbiguityCheck('{"ambiguous": true, "question": ""}')).toEqual({ ambiguous: false, question: '' })
  })
  it('returns null on malformed output', () => {
    expect(parseAmbiguityCheck('nope')).toBeNull()
    expect(parseAmbiguityCheck('{"ambiguous": "yes"}')).toBeNull()
  })
})

const CLASSIFIER_HIGH = JSON.stringify({
  riskLevel: 'HIGH', riskReason: 'deletes files', isTrivial: false, decomposedTasks: [], isReminderRequest: false,
  isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null, needsMultiStepPlan: false, statesDurableFacts: [],
})

/** Routes by system prompt: the ambiguity check vs the turn-intent classifier. */
function stubLlm(verdict: string | Error) {
  const calls = { ambiguity: 0, classifier: 0 }
  const llm = {
    async callChatStructured(messages: ChatMessage[], _t?: ToolDefinition[], _o?: ChatOptions): Promise<LLMStructuredResponse> {
      const system = String(messages[0]?.content ?? '')
      if (system.includes('fully determines the action')) {
        calls.ambiguity++
        if (verdict instanceof Error) throw verdict
        return { content: verdict, toolCalls: [] } as unknown as LLMStructuredResponse
      }
      calls.classifier++
      return { content: CLASSIFIER_HIGH, toolCalls: [] } as unknown as LLMStructuredResponse
    },
  } as unknown as ILLMClient
  return { llm, calls }
}

function interpreter(llm: ILLMClient, mode: AmbiguityGuardMode) {
  const planService = { loadActivePlan: async () => null } as never
  const reminderStore = { create: async () => undefined } as never
  return new TurnInterpreter(llm, () => undefined, planService, reminderStore, mode)
}

const base = { userMessage: 'Clear out the old ones.', sessionId: 's', toolLoopWillRun: true, approved: false, dangerouslySkipPermissions: false, onUsage: () => {} }

describe('AL3a ambiguity guard in TurnInterpreter', () => {
  const ambiguous = '{"ambiguous": true, "question": "What counts as old — before which year?"}'

  it('before (flag off): an ambiguous HIGH-risk request is staged for approval, no scope check made', async () => {
    const { llm, calls } = stubLlm(ambiguous)
    const out = await interpreter(llm, 'disabled').interpretIntent(base)
    expect(out.kind).toBe('needs_approval')
    expect(calls.ambiguity).toBe(0)
  })

  it('after (flag on): the same request gets a clarifying question and nothing is staged', async () => {
    const { llm, calls } = stubLlm(ambiguous)
    const out = await interpreter(llm, 'enabled').interpretIntent(base)
    expect(out.kind).toBe('needs_question')
    if (out.kind !== 'needs_question') return
    expect(out.result.status).toBe('ok')
    expect(out.result.reply).toBe('What counts as old — before which year?')
    expect(out.result.pendingActionId).toBeUndefined()
    expect(calls.ambiguity).toBe(1)
  })

  it('flag on, clear request: still staged for approval', async () => {
    const { llm } = stubLlm('{"ambiguous": false, "question": ""}')
    const out = await interpreter(llm, 'enabled').interpretIntent({ ...base, userMessage: 'Delete report-2024.txt' })
    expect(out.kind).toBe('needs_approval')
  })

  it('flag on, check errors: fails open to the existing approval gate', async () => {
    const { llm } = stubLlm(new Error('boom'))
    const out = await interpreter(llm, 'enabled').interpretIntent(base)
    expect(out.kind).toBe('needs_approval')
  })

  it('flag on: an already-approved turn is never re-questioned', async () => {
    const { llm, calls } = stubLlm(ambiguous)
    const out = await interpreter(llm, 'enabled').interpretIntent({ ...base, approved: true })
    expect(out.kind).toBe('proceed')
    expect(calls.ambiguity).toBe(0)
  })

  it('checkRequestAmbiguity includes recent conversation so an answered question is not re-asked', async () => {
    let seen = ''
    const llm = {
      async callChatStructured(messages: ChatMessage[]) {
        seen = String(messages[1]?.content ?? '')
        return { content: '{"ambiguous": false, "question": ""}', toolCalls: [] }
      },
    } as unknown as ILLMClient
    await checkRequestAmbiguity('older than 2025', llm, [
      { role: 'user', content: 'Clear out the old ones.' },
      { role: 'assistant', content: 'Old = before which year?' },
    ])
    expect(seen).toContain('Old = before which year?')
    expect(seen).toContain('older than 2025')
  })
})
