import { afterEach, describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { HarnessBridge, type HarnessRunParams } from './harness-bridge.js'
import type { PlanRecord } from './plan-store.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'

// AUDIT_REVIEWER_REVISION through the real bridge. An ordinary turn's success criterion is the generic "Respond helpfully…"
// default, which no belief can state — the implementer lens reports it as "not covered" on nearly every turn (214 of the 243
// reviewer findings across the eval transcripts). With the flag on that criterion is skipped, so there is nothing to act on.

class NoopLLM implements ILLMClient {
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], _o: ChatOptions = {}): Promise<LLMStructuredResponse> { return { content: '' } }
}

function bridge(): HarnessBridge {
  const memory = new InMemoryAdapter()
  const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const session = new AssistantSession(memory, checkpointStore, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, new InMemoryExperienceStore(), checkpointStore, new NoopLLM(), () => undefined, 5, new PlanService(memory), session, undefined, 'enabled')
}

const params = (extra: Partial<HarnessRunParams>): HarnessRunParams => ({
  sessionId: 's1',
  userMessage: 'hello',
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
  ...extra,
})

async function run(extra: Partial<HarnessRunParams> = {}) {
  let calls = 0
  const notes: string[] = []
  const outcome = await bridge().run(params({
    oneLoopProposer: () => { calls++; return { __harnessExecutionStatus: 'complete', output: `answer ${calls}` } },
    onReviewerRevision: (e) => notes.push(e.note),
    ...extra,
  }))
  const reviewer = outcome.status === 'completed' ? outcome.layerActivity.filter((l) => l.layer === 'reviewer_pass').map((l) => l.reason) : []
  return { calls, notes, reviewer }
}

describe('reviewer revision through the bridge', () => {
  afterEach(() => { delete process.env.AUDIT_REVIEWER_REVISION })

  it('flag off (the default): the default criterion is reported as not covered, as it always was, and the answer is not revised', async () => {
    const { calls, notes, reviewer } = await run()
    expect(reviewer.some((r) => r.startsWith('Success criterion not covered by any belief'))).toBe(true)
    expect(calls).toBe(1)
    expect(notes).toEqual([])
  })

  it('flag on: the non-checkable default criterion produces no finding, so there is nothing to revise', async () => {
    process.env.AUDIT_REVIEWER_REVISION = '1'
    const { calls, notes, reviewer } = await run()
    expect(reviewer.some((r) => r.startsWith('Success criterion not covered by any belief'))).toBe(false)
    expect(calls).toBe(1)
    expect(notes).toEqual([])
  })

  // A durable plan brings a real, checkable criterion: a plan's finish line no belief states until the work is done.
  const plan = { templateName: null, successCriteria: 'the migration is verified against production', rationale: 'r', tasks: [], mode: 'active', executingOnPlan: true } as unknown as PlanRecord
  const planTask: HarnessRunParams['initialTasks'][number] = {
    id: 'step1', description: 'verify', status: 'PENDING', risk_level: 'LOW', depends_on: [],
    parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
  }

  it('flag on with a real criterion nothing covers: the finding sends the answer back once, and the note carries the finding', async () => {
    process.env.AUDIT_REVIEWER_REVISION = '1'
    const { calls, notes } = await run({ activePlan: plan, initialTasks: [{ ...planTask }] })
    expect(calls).toBe(2)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('[revision] Success criterion not covered by any belief: "the migration is verified against production"')
  })

  it('the same run with the flag off is not revised', async () => {
    const { calls, notes } = await run({ activePlan: plan, initialTasks: [{ ...planTask }] })
    expect(calls).toBe(1)
    expect(notes).toEqual([])
  })

  it('a turn with no proposer (tool-less: the reply is already drafted) is never revised', async () => {
    process.env.AUDIT_REVIEWER_REVISION = '1'
    const notes: string[] = []
    const outcome = await bridge().run(params({ draftReply: 'already drafted', activePlan: plan, initialTasks: [{ ...planTask }], onReviewerRevision: (e) => notes.push(e.note) }))
    expect(outcome.status).toBe('completed')
    expect(notes).toEqual([])
  })
})
