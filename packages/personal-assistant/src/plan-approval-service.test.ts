import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'

const TURN_INTENT_MARKER = 'seven independent judgments'
const DRAFTING_MARKER = 'drafting a multi-step plan'

function isTurnIntentRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(TURN_INTENT_MARKER))
}

function isDraftingRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(DRAFTING_MARKER))
}

interface DraftTask {
  id: string
  description: string
  depends_on: string[]
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH'
}

interface DraftScriptEntry {
  tasks: DraftTask[]
  readyForApproval: boolean
  successCriteria?: string
  rationale?: string
}

/**
 * Drives the drafting call from a scripted queue (one entry consumed per plan-mode turn) and
 * answers `classifyTurnIntent` (fired once `planMode.active` is cleared and an ordinary turn
 * resumes) as a trivial LOW-risk turn with no active-plan re-matching, then a plain callChat
 * reply — enough to drive the fall-through-into-ordinary-pipeline path P2 introduces without
 * needing a real decomposition/plan-template LLM round trip.
 */
class ScriptedPlanLLMClient implements ILLMClient {
  private readonly script: DraftScriptEntry[]
  private i = 0
  draftingCalls = 0

  constructor(script: DraftScriptEntry[]) {
    this.script = script
  }

  async *callChat(): AsyncIterable<string> {
    yield 'Continuing the approved plan.'
  }

  async callChatSync(): Promise<string> {
    return 'Continuing the approved plan.'
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) {
      return {
        content: JSON.stringify({
          riskLevel: 'LOW',
          riskReason: 'continuing an already-approved plan',
          isTrivial: false,
          decomposedTasks: null,
          isReminderRequest: false,
          isBulkReminderRequest: false,
          isAbandonRequest: false,
          matchedPlanTemplate: null,
        }),
      }
    }
    if (isDraftingRequest(messages)) {
      const entry = this.script[Math.min(this.draftingCalls, this.script.length - 1)]
      this.draftingCalls++
      return {
        content: JSON.stringify({
          reply: 'Here is the current draft.',
          success_criteria: entry.successCriteria ?? 'Ship it.',
          rationale: entry.rationale ?? 'Because it works.',
          ready_for_approval: entry.readyForApproval,
          tasks: entry.tasks,
        }),
      }
    }
    throw new Error(`unexpected callChatStructured: ${JSON.stringify(messages)}`)
  }
}

const THREE_LOW_RISK_TASKS: DraftTask[] = [
  { id: 't1', description: 'Task one', depends_on: [], risk_level: 'LOW' },
  { id: 't2', description: 'Task two', depends_on: [], risk_level: 'LOW' },
  { id: 't3', description: 'Task three', depends_on: [], risk_level: 'LOW' },
]

describe('plan mode (P2) — mandatory whole-plan approval gate', () => {
  it('a revision with readyForApproval stages the plan instead of returning an ordinary drafting reply', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'stage-session'
    await assistant.enterPlanMode(sessionId)

    const result = await assistant.turn('Looks good, let\'s do it.', { sessionId })
    expect(result.status).toBe('needs_plan_approval')
    expect(result.reply).toBeNull()
    expect(typeof result.planApprovalId).toBe('string')
    expect(result.planApproval?.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('all-LOW-risk plan still requires approval — no risk-tiered skip to active', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'all-low-session'
    await assistant.enterPlanMode(sessionId)

    const result = await assistant.turn('Approve it.', { sessionId })
    expect(result.status).toBe('needs_plan_approval')
    expect(result.planApproval?.tasks.every((t) => t.riskLevel === 'LOW')).toBe(true)
  })

  it('approve activates the plan, clears planMode, and lets the same message fall through to run task 1', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'approve-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })
    expect(staged.status).toBe('needs_plan_approval')

    const resumed = await assistant.turn('go', {
      sessionId,
      planApprovalId: staged.planApprovalId,
      planDecision: 'approve',
    })

    // The ordinary pipeline (TurnInterpreter.resolveTasks -> loadActivePlan) picked up the
    // now-active plan and ran its first task — same mechanism a freshly template-matched plan
    // already uses today, no new execution-driving code needed.
    expect(resumed.status).toBe('ok')
    expect(resumed.planStatus?.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])

    const stillActive = await assistant.turn('Draft another one.', { sessionId })
    // planMode.active was cleared by approval, so this is now an ordinary turn, not routed back
    // into PlanDraftingService.
    expect(stillActive.reply).not.toMatch(/couldn't update the plan draft/i)
  })

  it('approve_with_edits cancels one task and edits another before the plan is activated', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'edits-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })

    const resumed = await assistant.turn('go', {
      sessionId,
      planApprovalId: staged.planApprovalId,
      planDecision: 'approve_with_edits',
      planEdits: { cancelTaskIds: ['t2'], editedTasks: [{ id: 't3', description: 'Task three, reworded' }] },
    })

    expect(resumed.status).toBe('ok')
    const tasks = resumed.planStatus?.tasks ?? []
    expect(tasks.find((t) => t.id === 't2')?.status).toBe('COMPLETE')
    expect(tasks.find((t) => t.id === 't3')?.description).toBe('Task three, reworded')
  })

  it('decline discards the draft, clears planMode, and lets the message fall through with no active plan', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'decline-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })

    const resumed = await assistant.turn('never mind', {
      sessionId,
      planApprovalId: staged.planApprovalId,
      planDecision: 'decline',
    })

    expect(resumed.status).toBe('ok')
    // No plan drove this turn — the message fell through to the ordinary single-task pipeline.
    expect(resumed.planStatus).toBeUndefined()
  })

  it('an unknown/stale planApprovalId resolves as a no-op instead of touching any plan state', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'stale-id-session'
    await assistant.enterPlanMode(sessionId)
    await assistant.turn('Approve it.', { sessionId })

    const result = await assistant.turn('go', { sessionId, planApprovalId: 'not-a-real-id', planDecision: 'approve' })
    expect(result.status).toBe('ok')
    expect(result.reply).toMatch(/no longer pending/i)
  })

  it('omitting planDecision leaves the plan awaiting approval (fail closed)', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'no-decision-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })

    const result = await assistant.turn('go', { sessionId, planApprovalId: staged.planApprovalId })
    expect(result.status).toBe('needs_plan_approval')
    expect(result.reason).toMatch(/no decision/i)

    // Still resolvable afterward with a real decision — nothing was corrupted by the missing one.
    const resumed = await assistant.turn('go', { sessionId, planApprovalId: staged.planApprovalId, planDecision: 'approve' })
    expect(resumed.status).toBe('ok')
  })

  it('fail-closed: a bad edit (unknown task id) leaves the plan awaiting approval instead of activating it', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'bad-edit-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })

    const failed = await assistant.turn('go', {
      sessionId,
      planApprovalId: staged.planApprovalId,
      planDecision: 'approve_with_edits',
      planEdits: { editedTasks: [{ id: 'not-a-real-task', description: 'x' }] },
    })
    expect(failed.status).toBe('needs_plan_approval')
    expect(failed.planApprovalId).toBe(staged.planApprovalId)

    // The plan is still exactly staged — the same planApprovalId still resolves correctly.
    const resumed = await assistant.turn('go', { sessionId, planApprovalId: staged.planApprovalId, planDecision: 'approve' })
    expect(resumed.status).toBe('ok')
  })

  it('a plan already staged for approval rejects further drafting input instead of silently starting a new draft', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'still-drafting-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })
    expect(staged.status).toBe('needs_plan_approval')

    const stray = await assistant.turn('actually add a fourth task', { sessionId })
    expect(stray.status).toBe('ok')
    expect(stray.reply).toMatch(/already staged for approval/i)
    // No second drafting call was spent — the staged-for-approval check short-circuits before it.
    expect(llm.draftingCalls).toBe(1)

    // The original staged plan is untouched and still resolvable.
    const resumed = await assistant.turn('go', { sessionId, planApprovalId: staged.planApprovalId, planDecision: 'approve' })
    expect(resumed.status).toBe('ok')
  })

  it('an explicit cancel phrase discards a plan staged for approval too, not just a plain draft', async () => {
    const llm = new ScriptedPlanLLMClient([{ tasks: THREE_LOW_RISK_TASKS, readyForApproval: true }])
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'cancel-staged-session'
    await assistant.enterPlanMode(sessionId)
    const staged = await assistant.turn('Approve it.', { sessionId })
    expect(staged.status).toBe('needs_plan_approval')

    const cancelled = await assistant.turn('cancel this plan', { sessionId })
    expect(cancelled.reply).toMatch(/stopped drafting/i)

    // The staged plan is gone — its ID no longer resolves.
    const stale = await assistant.turn('go', { sessionId, planApprovalId: staged.planApprovalId, planDecision: 'approve' })
    expect(stale.reply).toMatch(/no longer pending/i)
  })
})
