import { afterEach, describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { HarnessBridge, type HarnessRunParams } from './harness-bridge.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'
import { harnessTokenBudgetTotal } from './harness-token-budget.js'

// AUDIT_HARNESS_TOKEN_BUDGET: the memory layer's token budget is fed from the turn's real usage (off ⇒ 0 of 200,000, as before).

const llm: ILLMClient = {
  async *callChat() { yield '' },
  async callChatSync() { return '' },
  async callChatStructured(): Promise<LLMStructuredResponse> { return { content: '' } },
}

function bridge(): HarnessBridge {
  const memory = new InMemoryAdapter()
  const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const session = new AssistantSession(memory, checkpointStore, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, new InMemoryExperienceStore(), checkpointStore, llm, () => undefined, 5, new PlanService(memory), session, undefined, 'enabled')
}

const params = (tokensUsed?: () => number): HarnessRunParams => ({
  sessionId: 's1',
  userMessage: 'summarise the notes',
  facts: [],
  draftReply: '',
  classification: {
    riskLevel: 'LOW', riskReason: 'test', requiresApproval: false, isTrivial: false, decomposedTasks: null,
    isReminderRequest: false, isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null,
    needsMultiStepPlan: false, statesDurableFacts: [],
  },
  initialTasks: [],
  activePlan: null,
  sources: undefined,
  onUsage: () => {},
  oneLoopProposer: () => ({ __harnessExecutionStatus: 'complete', output: 'done' }),
  ...(tokensUsed ? { tokensUsed } : {}),
})

async function budget(tokensUsed?: () => number) {
  const outcome = await bridge().run(params(tokensUsed))
  if (outcome.status !== 'completed') throw new Error('expected a completed run')
  return outcome.result.initResult.memoryState.token_budget
}

describe('AUDIT_HARNESS_TOKEN_BUDGET', () => {
  afterEach(() => { delete process.env.AUDIT_HARNESS_TOKEN_BUDGET })

  it('parses a positive integer, and nothing else', () => {
    expect(harnessTokenBudgetTotal({ AUDIT_HARNESS_TOKEN_BUDGET: '30000' })).toBe(30000)
    for (const bad of ['', '0', '-5', '1.5', 'on', '1e5', ' ']) expect(harnessTokenBudgetTotal({ AUDIT_HARNESS_TOKEN_BUDGET: bad })).toBeUndefined()
    expect(harnessTokenBudgetTotal({})).toBeUndefined()
  })

  it('on: the harness sees the configured total and the turn\'s usage', async () => {
    process.env.AUDIT_HARNESS_TOKEN_BUDGET = '1000'
    expect(await budget(() => 420)).toEqual({ total: 1000, used: 420 })
  })

  it('off (negative control): the budget keeps its defaults even when usage is reported', async () => {
    expect(await budget(() => 420)).toEqual({ total: 200000, used: 0 })
  })

  it('on but the host reports no usage reader: defaults', async () => {
    process.env.AUDIT_HARNESS_TOKEN_BUDGET = '1000'
    expect(await budget()).toEqual({ total: 200000, used: 0 })
  })
})
