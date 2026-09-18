import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import type { InvestigationRequestData, InvestigationFinding } from '@buildaharness/harness'
import { PlanSketchService } from './plan-sketch-service.js'
import { PersonalAssistant } from './assistant.js'
import type { AgentLoop } from './agent-loop.js'
import type { TraceEvent } from './trace-events.js'

const TURN_INTENT_MARKER = 'eight independent judgments'

function isTurnIntentRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(TURN_INTENT_MARKER))
}

/**
 * Answers a plain sketch reply for any non-structured call, and — if the drafting/ordinary
 * pipeline is ever reached instead (the exact bug P9's INV-35 guards against) — a trivial LOW-risk
 * ordinary turn, so a test that accidentally exercised the wrong path fails on a visible
 * assertion (PlanRecord/planMode state) rather than a thrown error that could be mistaken for
 * expected behavior.
 */
class SketchLLMClient implements ILLMClient {
  calls = 0
  async *callChat(): AsyncIterable<string> {
    yield 'An ordinary reply.'
  }
  async callChatSync(): Promise<string> {
    this.calls++
    return 'Step 1: look around. Step 2: make the change.'
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) {
      return {
        content: JSON.stringify({
          riskLevel: 'LOW', riskReason: 'ordinary question', isTrivial: true, decomposedTasks: [],
          isReminderRequest: false, isBulkReminderRequest: false, isAbandonRequest: false,
          matchedPlanTemplate: null, needsMultiStepPlan: false,
        }),
      }
    }
    throw new Error('unexpected structured call in sketch test')
  }
}

describe('PlanSketchService (P9 — lightweight plan-sketch delegate)', () => {
  it('grounds via the shared bounded investigation walk (same shape P3 uses) and folds findings into the sketch call', async () => {
    const investigate = vi.fn(async (req: InvestigationRequestData): Promise<InvestigationFinding[]> => {
      expect(req.suggested_tools).toEqual(['read_file', 'list_directory'])
      expect(req.budget).toBe(8)
      return [{ content: 'found src/index.ts', tool: 'read_file', reliability: 'MEDIUM' }]
    })
    const agentLoop = { runSupervisorInvestigation: investigate } as unknown as Pick<AgentLoop, 'runSupervisorInvestigation'>
    const llm = new SketchLLMClient()
    const service = new PlanSketchService(llm, () => undefined, undefined, agentLoop)

    const result = await service.sketch('Add a health check endpoint', () => {})
    expect(investigate).toHaveBeenCalledTimes(1)
    expect(llm.calls).toBe(1)
    expect(result).toEqual({ status: 'ok', reply: 'Step 1: look around. Step 2: make the change.', riskLevel: 'LOW', harnessSkipped: true })
  })

  it('skips grounding entirely when no agentLoop is wired', async () => {
    const llm = new SketchLLMClient()
    const service = new PlanSketchService(llm, () => undefined, undefined, undefined)
    const result = await service.sketch('Add a health check endpoint', () => {})
    expect(result.reply).toBe('Step 1: look around. Step 2: make the change.')
  })

  it('falls back to a generic reply instead of throwing when the sketch call fails', async () => {
    class ThrowingLLMClient implements ILLMClient {
      async *callChat(): AsyncIterable<string> {
        yield ''
      }
      async callChatSync(): Promise<string> {
        throw new Error('boom')
      }
      async callChatStructured(): Promise<LLMStructuredResponse> {
        throw new Error('boom')
      }
    }
    const service = new PlanSketchService(new ThrowingLLMClient(), () => undefined, undefined, undefined)
    const result = await service.sketch('Add a health check endpoint', () => {})
    expect(result.status).toBe('ok')
    expect(result.reply).toMatch(/couldn't sketch/i)
  })

  it('emits a name/status-only plan_sketch trace event, never the full request text', async () => {
    const events: TraceEvent[] = []
    const llm = new SketchLLMClient()
    const longRequest = 'x'.repeat(500)
    const service = new PlanSketchService(llm, () => undefined, (e) => events.push(e), undefined)
    await service.sketch(longRequest, () => {})
    const sketchEvent = events.find((e) => e.kind === 'plan_sketch')
    expect(sketchEvent).toBeDefined()
    if (sketchEvent?.kind === 'plan_sketch') {
      expect(sketchEvent.requestPreview.length).toBeLessThan(longRequest.length)
    }
  })
})

describe('PersonalAssistant.sketchPlan (P9)', () => {
  it(
    'INV-35: never creates a PlanRecord or touches planMode state, and the very next ordinary ' +
      'turn is unaffected — it runs the normal pipeline, not plan-mode drafting',
    async () => {
      const assistant = new PersonalAssistant({ llmClient: new SketchLLMClient() })
      const result = await assistant.sketchPlan('sess-sketch', 'Add a health check endpoint')

      expect(result.status).toBe('ok')
      expect(result.reply).toBe('Step 1: look around. Step 2: make the change.')
      expect(result.planStatus).toBeUndefined()

      // No PlanRecord was ever created for this session.
      expect(await assistant.getPlanState('sess-sketch')).toBeNull()

      // A following ordinary turn is not routed into plan-mode drafting (SketchLLMClient throws
      // on any structured call it doesn't recognize as either the turn-intent classifier or a
      // trivial reply — reaching PlanDraftingService's revision call, which asks a different
      // structured question, would throw here).
      const next = await assistant.turn('hello', { sessionId: 'sess-sketch' })
      expect(next.status).toBe('ok')
    },
  )

  it('records real token usage on the returned result and against session spend', async () => {
    class UsageLLMClient implements ILLMClient {
      async *callChat(): AsyncIterable<string> {
        yield ''
      }
      async callChatSync(_messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
        options.onUsage?.({ inputTokens: 5, outputTokens: 7 })
        return 'sketch reply'
      }
      async callChatStructured(): Promise<LLMStructuredResponse> {
        throw new Error('unexpected')
      }
    }
    const assistant = new PersonalAssistant({ llmClient: new UsageLLMClient() })
    const result = await assistant.sketchPlan('sess-usage', 'Add a health check endpoint')
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 })
    const spend = await assistant.getSpendState('sess-usage')
    expect(spend.cumulativeInputTokens).toBeGreaterThan(0)
  })
})
