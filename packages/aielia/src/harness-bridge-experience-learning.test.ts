import { afterEach, describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { HarnessBridge, experienceLearningEnabled, type HarnessRunParams } from './harness-bridge.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'

// AUDIT_EXPERIENCE_LEARNING through the real bridge: the recovery ladder switches strategy after a failed task, and a run that
// then succeeds teaches the (persistent) experience store which strategy answered that failure.

class NoopLLM implements ILLMClient {
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], _o: ChatOptions = {}): Promise<LLMStructuredResponse> { return { content: '' } }
}

function bridgeWith(store: InMemoryExperienceStore): HarnessBridge {
  const memory = new InMemoryAdapter()
  const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const session = new AssistantSession(memory, checkpointStore, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, store, checkpointStore, new NoopLLM(), () => undefined, 5, new PlanService(memory), session, undefined, 'enabled')
}

const task = (id: string): HarnessRunParams['initialTasks'][number] => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: [],
  parallel_write_domains: ['shared'], abstraction_level: 1, assigned_strategy: null,
})

const params = (): HarnessRunParams => ({
  sessionId: 's1', userMessage: 'hello', facts: [], draftReply: '',
  classification: {
    riskLevel: 'LOW', riskReason: 'test', requiresApproval: false, isTrivial: false, decomposedTasks: null,
    isReminderRequest: false, isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null,
    needsMultiStepPlan: false, statesDurableFacts: [],
  },
  initialTasks: [task('t1'), task('t2')],
  activePlan: null,
  sources: undefined,
  onUsage: () => {},
  // t1 fails (kind 'exhausted' — not retried by the system-error rule), the ladder switches strategy, and the independent t2 then succeeds under the new one
  oneLoopProposer: (ctx) => (ctx.currentTaskId === 't1' ? { __harnessExecutionStatus: 'failed', __harnessFailureKind: 'exhausted', error: 'boom' } : { __harnessExecutionStatus: 'complete', output: 'ok' }),
})

const learnedWeights = (store: InMemoryExperienceStore) => Object.fromEntries(Object.entries(store.getStrategyWeights()).filter(([k]) => !k.startsWith('layer_outcome')))

describe('experienceLearningEnabled (AUDIT_EXPERIENCE_LEARNING)', () => {
  it('is OFF unless a truthy value is set', () => {
    expect(experienceLearningEnabled({})).toBe(false)
    expect(experienceLearningEnabled({ AUDIT_EXPERIENCE_LEARNING: '' })).toBe(false)
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) expect(experienceLearningEnabled({ AUDIT_EXPERIENCE_LEARNING: v }), v).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' ON ']) expect(experienceLearningEnabled({ AUDIT_EXPERIENCE_LEARNING: v }), v).toBe(true)
  })
})

describe('experience learning through the bridge', () => {
  afterEach(() => { delete process.env.AUDIT_EXPERIENCE_LEARNING })

  it('flag off (the default): the experience store learns no strategy weights', async () => {
    const store = new InMemoryExperienceStore()
    await bridgeWith(store).run(params())
    expect(learnedWeights(store)).toEqual({})
  })

  it('flag on: the store learns that the strategy the ladder switched to answered the failure', async () => {
    process.env.AUDIT_EXPERIENCE_LEARNING = '1'
    const store = new InMemoryExperienceStore()
    await bridgeWith(store).run(params())
    expect(learnedWeights(store)['TRACE_EXEC:']).toBeGreaterThan(0.5)
  })

  it('the learned weights rank the strategy that worked above the one that failed', async () => {
    process.env.AUDIT_EXPERIENCE_LEARNING = '1'
    const store = new InMemoryExperienceStore()
    const bridge = bridgeWith(store)
    await bridge.run(params())
    const w = learnedWeights(store)
    expect(w['TRACE_EXEC:']).toBeGreaterThan(w['DIRECT_EDIT:'])
  })
})
