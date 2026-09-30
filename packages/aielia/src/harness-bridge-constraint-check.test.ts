import { afterEach, describe, it, expect } from 'vitest'
import { InMemoryExperienceStore, OutputContractError, type UpdateChannel } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { HarnessBridge, type HarnessRunParams } from './harness-bridge.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'

// AUDIT_SEMANTIC_CONSTRAINT_CHECK through the real bridge: a constraint delivered mid-run is judged by the model,
// not matched by words. "I will not use tabs" obeys "Do not use tabs" but names its subject.

const REPLY = 'I will not use tabs; spaces only.'

class JudgeLLM implements ILLMClient {
  judged = 0
  constructor(private readonly answer: string) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(m: ChatMessage[], _t?: ToolDefinition[], _o: ChatOptions = {}): Promise<LLMStructuredResponse> {
    if (m.some((x) => x.role === 'system' && x.content.includes('violates constraints'))) {
      this.judged++
      return { content: this.answer }
    }
    return { content: '' }
  }
}

function bridge(llm: ILLMClient): HarnessBridge {
  const memory = new InMemoryAdapter()
  const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const session = new AssistantSession(memory, checkpointStore, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, new InMemoryExperienceStore(), checkpointStore, llm, () => undefined, 5, new PlanService(memory), session, undefined, 'enabled')
}

function constraintOnce(): UpdateChannel {
  let sent = false
  return { poll: () => (sent ? null : ((sent = true), { pending_update: { current_constraints: ['Do not use tabs'] }, constraints_changed: true })) }
}

const params = (): HarnessRunParams => ({
  sessionId: 's1',
  userMessage: 'write the indentation guide',
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
  oneLoopProposer: () => ({ __harnessExecutionStatus: 'complete', output: REPLY }),
  updateChannel: constraintOnce(),
})

async function run(llm: ILLMClient) {
  try {
    return { outcome: await bridge(llm).run(params()), error: undefined as unknown }
  } catch (error) {
    return { outcome: undefined, error }
  }
}

describe('semantic constraint check through the bridge', () => {
  afterEach(() => { delete process.env.AUDIT_SEMANTIC_CONSTRAINT_CHECK })

  it('default (on): a reply that acknowledges the constraint passes, and the model was asked', async () => {
    const llm = new JudgeLLM('{"violations":[]}')
    const r = await run(llm)
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status).toBe('completed')
    expect(llm.judged).toBe(1)
  })

  it('default (on): a violation the model names fails validation', async () => {
    const llm = new JudgeLLM('{"violations":[{"constraint":"Do not use tabs","reason":"indents with a tab"}]}')
    const r = await run(llm)
    expect(r.error).toBeInstanceOf(OutputContractError)
    expect(llm.judged).toBe(1)
  })

  it('off: the lexical word match is back, so the same acknowledging reply throws and no model call is made', async () => {
    process.env.AUDIT_SEMANTIC_CONSTRAINT_CHECK = '0'
    const llm = new JudgeLLM('{"violations":[]}')
    const r = await run(llm)
    expect(r.error).toBeInstanceOf(OutputContractError)
    expect(llm.judged).toBe(0)
  })
})
