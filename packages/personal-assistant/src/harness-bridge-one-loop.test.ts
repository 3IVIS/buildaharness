import { describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { HarnessBridge } from './harness-bridge.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'

/**
 * R2 of plans/harness_d2_one_loop_rewire_plan.html: HarnessBridge.run() reads the one-loop flag
 * once per turn (its own constructor param, injected — see one-loop-flag.ts) and decides between
 * `() => draftReply` and a caller-supplied `oneLoopProposer` for the toolExecutors 'default' entry.
 * INV-19 requires flag-OFF (and flag-ON with no proposer supplied) to stay byte-identical to
 * today's `() => draftReply` behavior; these tests exercise both branches end to end through a
 * full HarnessRuntime run rather than just asserting the ternary in isolation.
 */
class NoopLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    return { content: '' }
  }
}

function buildBridge(oneLoopMode: 'enabled' | 'disabled'): HarnessBridge {
  const memory = new InMemoryAdapter()
  const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const experienceStore = new InMemoryExperienceStore()
  const planService = new PlanService(memory)
  const session = new AssistantSession(memory, checkpointStore, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, experienceStore, checkpointStore, new NoopLLMClient(), () => undefined, 5, planService, session, undefined, oneLoopMode)
}

const baseParams = {
  sessionId: 'session-1',
  userMessage: 'hello',
  facts: [],
  classification: {
    riskLevel: 'LOW' as const,
    riskReason: 'test',
    requiresApproval: false,
    isTrivial: false,
    decomposedTasks: null,
    isReminderRequest: false,
    isBulkReminderRequest: false,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    statesDurableFact: null,
  },
  initialTasks: [],
  activePlan: null,
  sources: undefined,
  onUsage: () => {},
}

describe('HarnessBridge one-loop flag wiring (R2)', () => {
  it('flag disabled: an oneLoopProposer, even if supplied, is ignored — draftReply wins (INV-19)', async () => {
    const bridge = buildBridge('disabled')
    let proposerCalled = false
    const outcome = await bridge.run({
      ...baseParams,
      draftReply: 'the draft reply',
      oneLoopProposer: () => {
        proposerCalled = true
        return { __harnessExecutionStatus: 'complete', output: 'from the proposer' }
      },
    })
    expect(proposerCalled).toBe(false)
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') expect(outcome.result.finalResult).toBe('the draft reply')
  })

  it('flag enabled with no proposer supplied: still draftReply (INV-19 — R3 is what actually wires a real caller-supplied proposer)', async () => {
    const bridge = buildBridge('enabled')
    const outcome = await bridge.run({ ...baseParams, draftReply: 'the draft reply' })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') expect(outcome.result.finalResult).toBe('the draft reply')
  })

  it('flag enabled with a proposer supplied: the proposer\'s output becomes the real finalResult', async () => {
    const bridge = buildBridge('enabled')
    const outcome = await bridge.run({
      ...baseParams,
      draftReply: 'the draft reply',
      oneLoopProposer: () => ({ __harnessExecutionStatus: 'complete', output: 'from the proposer' }),
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') expect(outcome.result.finalResult).toBe('from the proposer')
  })
})
