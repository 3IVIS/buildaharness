import { describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import type { LayerPolicyMode, ExperienceStore } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { HarnessBridge } from './harness-bridge.js'
import { PlanService } from './plan-service.js'
import { AssistantSession } from './assistant-session.js'
import { renderLayerYield } from '../scripts/layer-yield.js'
import { renderShadowReport } from '../scripts/shadow-report.js'

/** AL9b: outcome rows appear in a scripted end-to-end turn and carry no user content (AL-10). */
class NoopLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], _o: ChatOptions = {}): Promise<LLMStructuredResponse> { return { content: '' } }
}

const SECRET = 'my password is hunter2'

/** The in-memory store keeps rows private; capture what is written. */
class CapturingStore extends InMemoryExperienceStore {
  written = new Map<string, Record<string, unknown>>()
  override updateExperienceStore(runId: string, outcome: Record<string, unknown>): void {
    this.written.set(runId, outcome)
    super.updateExperienceStore(runId, outcome)
  }
}

function bridge(mode: LayerPolicyMode, store: ExperienceStore) {
  const memory = new InMemoryAdapter()
  const cp = new InMemoryAdapter({ scope: 'thread', namespace: 'checkpoints' })
  const session = new AssistantSession(memory, cp, undefined, () => undefined, undefined, undefined, undefined)
  return new HarnessBridge(memory, store, cp, new NoopLLMClient(), () => undefined, 5, new PlanService(memory), session, undefined, 'disabled', mode)
}

const classification = (pushback: boolean) => ({
  riskLevel: 'LOW' as const, riskReason: 'test', requiresApproval: false, isTrivial: false, decomposedTasks: null,
  isReminderRequest: false, isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null,
  needsMultiStepPlan: false, statesDurableFacts: [], pushbackOnPriorTurn: pushback,
})
const params = (sessionId: string, pushback = false) => ({
  sessionId, userMessage: SECRET, facts: [], draftReply: SECRET, classification: classification(pushback),
  initialTasks: [], activePlan: null, sources: undefined, onUsage: () => {},
})

describe('AL9b layer telemetry through HarnessBridge', () => {
  it('shadow: writes an outcome row and a shadow row, plus next-turn feedback, with no message text', async () => {
    const store = new CapturingStore()
    const b = bridge('shadow', store)
    await b.run(params('s1'))
    await b.run(params('s1', true))
    const keys = [...store.written.keys()]
    const outcomeKeys = keys.filter(k => k.startsWith('layer_outcome:'))
    expect(outcomeKeys).toHaveLength(2)
    expect(keys.filter(k => k.startsWith('shadow_turn:'))).toHaveLength(2)
    const fb = keys.filter(k => k.startsWith('layer_outcome_feedback:'))
    expect(fb).toHaveLength(1)
    expect(store.written.get(fb[0])).toMatchObject({ nextTurnCorrection: true })
    expect(JSON.stringify([...store.written.entries()].filter(([k]) => /^(layer_outcome|shadow_turn)/.test(k)))).not.toContain('hunter2')
    // the same rows feed both reports
    const log = [...store.written.entries()].filter(([k]) => /^(layer_outcome|shadow_turn)/.test(k)).map(([, v]) => JSON.stringify(v)).join('\n')
    expect(renderLayerYield(log)).toContain('| layer |')
    expect(renderShadowReport(log)).toContain('shadow turns: 2')
  })

  it('static: an outcome row is written but there is no shadow row', async () => {
    const store = new CapturingStore()
    await bridge('static', store).run(params('s2'))
    const keys = [...store.written.keys()]
    expect(keys.some(k => k.startsWith('layer_outcome:'))).toBe(true)
    expect(keys.some(k => k.startsWith('shadow_turn:'))).toBe(false)
  })
})
