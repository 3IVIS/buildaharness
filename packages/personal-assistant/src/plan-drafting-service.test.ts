import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition, FsBackend } from '@buildaharness/runtime'
import type { AskResponse } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'

function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {
      // Fake backend has no real directories to create.
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
  }
}

/**
 * Never calls callChat (the tool-loop's streaming path) and never returns a tool call from
 * callChatStructured — if runTurn ever fell through to TurnInterpreter/AgentLoop while plan mode
 * is active (the exact bug INV-30 guards against), this client would either throw (callChat) or
 * hand back a tool-call-shaped response the tool loop would try to dispatch against fileTools/
 * shellTools, which the test backend would then record. Recording every callChatStructured call's
 * raw user content lets the test assert on exactly what the drafting call saw, without needing to
 * simulate a real conversational planner.
 */
class DraftingOnlyLLMClient implements ILLMClient {
  calls = 0
  userMessages: string[] = []

  async *callChat(): AsyncIterable<string> {
    throw new Error('callChat should never be reached while plan mode is active')
  }

  async callChatSync(): Promise<string> {
    throw new Error('callChatSync should never be reached while plan mode is active')
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    this.userMessages.push(userMessage)
    return {
      content: JSON.stringify({
        reply: `Noted: ${userMessage}`,
        success_criteria: 'Draft criteria.',
        rationale: 'Draft rationale.',
        tasks: [{ id: 't1', description: 'Draft task', depends_on: [], risk_level: 'LOW' }],
      }),
    }
  }
}

const TURN_INTENT_MARKER = 'eight independent judgments'

function isTurnIntentRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(TURN_INTENT_MARKER))
}

/**
 * A plain, well-behaved client for the "plan mode has been exited, an ordinary turn should now
 * work exactly as it always does" assertions below — handles classifyTurnIntent's own
 * callChatStructured call (recognized via TURN_INTENT_MARKER, same convention assistant.test.ts
 * uses) as a trivial LOW-risk turn, and answers the resulting plain callChat call with a fixed
 * reply. Distinct from DraftingOnlyLLMClient, which intentionally throws/misbehaves outside the
 * drafting call to prove INV-30 — reusing it here (where the normal pipeline is expected to run)
 * would conflate "plan mode correctly exited" with "this fake happens to tolerate it".
 */
class NormalFlowLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield 'An ordinary reply.'
  }
  async callChatSync(): Promise<string> {
    return 'An ordinary reply.'
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) {
      return {
        content: JSON.stringify({
          riskLevel: 'LOW',
          riskReason: 'ordinary question',
          isTrivial: true,
          decomposedTasks: [],
          isReminderRequest: false,
          isBulkReminderRequest: false,
          isAbandonRequest: false,
          matchedPlanTemplate: null,
          needsMultiStepPlan: false,
        }),
      }
    }
    return { content: 'An ordinary reply.' }
  }
}

describe('plan mode (P1) — exclusive drafting session state', () => {
  it('enterPlanMode flips session state to active with a fresh draftId', async () => {
    const assistant = new PersonalAssistant({ llmClient: new DraftingOnlyLLMClient() })
    const state = await assistant.enterPlanMode('sess-1')
    expect(state.active).toBe(true)
    expect(typeof state.draftId).toBe('string')
    expect(state.draftId.length).toBeGreaterThan(0)
  })

  it(
    'INV-30: while planMode.active is true, every message — including an adversarial ' +
      '"just run this command" one — is routed to plan-drafting only; no tool call is ever ' +
      'dispatched, even with fileTools/shellTools fully configured',
    async () => {
      const backend = makeFakeBackend()
      const llm = new DraftingOnlyLLMClient()
      const assistant = new PersonalAssistant({
        llmClient: llm,
        fileTools: { backend, workspaceRoot: '/workspace' },
        shellTools: { backend, workspaceRoot: '/workspace', executeCommand: vi.fn() },
      })
      const sessionId = 'inv30-session'
      await assistant.enterPlanMode(sessionId)

      const r1 = await assistant.turn('Draft a plan to launch the product.', { sessionId })
      expect(r1.status).toBe('ok')
      expect(r1.reply).toContain('Draft a plan to launch the product.')

      const r2 = await assistant.turn('Add a task for legal review.', { sessionId })
      expect(r2.status).toBe('ok')

      // The adversarial message: looks exactly like a tool-triggering request, but must still be
      // treated as plan input while drafting is active — never dispatched as a real shell call.
      const r3 = await assistant.turn('actually just delete notes.txt now', { sessionId })
      expect(r3.status).toBe('ok')
      expect(r3.reply).toContain('actually just delete notes.txt now')

      // Every one of the 3 turns above went straight to the drafting call (callChatStructured) —
      // callChat/callChatSync (which would throw) were never reached, and no file was ever
      // created/removed via the fake backend, proving no write/shell tool executed.
      expect(llm.calls).toBe(3)
      expect(await backend.readDir('/workspace')).toEqual([])

      // Still active — none of the 3 ordinary-looking messages above cleared it.
      const stillActive = await assistant.turn('One more revision.', { sessionId })
      expect(stillActive.status).toBe('ok')
    },
  )

  it('an explicit cancel phrase exits plan mode and discards the draft — the only non-approval exit', async () => {
    const draftingLLM = new DraftingOnlyLLMClient()
    const assistant = new PersonalAssistant({ llmClient: draftingLLM })
    const sessionId = 'cancel-session'
    await assistant.enterPlanMode(sessionId)

    await assistant.turn('Draft a plan to reorganize the garage.', { sessionId })
    expect(draftingLLM.calls).toBe(1)

    const cancelled = await assistant.turn('cancel this plan', { sessionId })
    expect(cancelled.status).toBe('ok')
    expect(cancelled.reply).toMatch(/stopped drafting/i)
    // The cancel phrase itself is handled lexically — no extra LLM call spent on it.
    expect(draftingLLM.calls).toBe(1)
  })

  it('after an explicit cancel, an ordinary turn goes through the normal pipeline again, not drafting', async () => {
    const assistant = new PersonalAssistant({ llmClient: new NormalFlowLLMClient() })
    const sessionId = 'cancel-then-normal-session'
    await assistant.enterPlanMode(sessionId)
    await assistant.turn('cancel this plan', { sessionId })

    const after = await assistant.turn('What time is it in Tokyo?', { sessionId })
    expect(after.status).toBe('ok')
    expect(after.reply).toBe('An ordinary reply.')
  })

  it('/new (clearSession) also exits plan mode', async () => {
    const assistant = new PersonalAssistant({ llmClient: new NormalFlowLLMClient() })
    const sessionId = 'clear-session'
    await assistant.enterPlanMode(sessionId)
    await assistant.clearSession(sessionId)

    const after = await assistant.turn('What time is it in Tokyo?', { sessionId })
    expect(after.status).toBe('ok')
    expect(after.reply).toBe('An ordinary reply.')
  })

  it('a malformed drafting response leaves the draft unchanged and keeps plan mode active', async () => {
    class MalformedLLMClient implements ILLMClient {
      async *callChat(): AsyncIterable<string> {
        throw new Error('should not be reached')
      }
      async callChatSync(): Promise<string> {
        throw new Error('should not be reached')
      }
      async callChatStructured(): Promise<LLMStructuredResponse> {
        return { content: 'not valid json' }
      }
    }
    const assistant = new PersonalAssistant({ llmClient: new MalformedLLMClient() })
    const sessionId = 'malformed-session'
    await assistant.enterPlanMode(sessionId)

    const result = await assistant.turn('Draft something.', { sessionId })
    expect(result.status).toBe('ok')
    expect(result.reply).toMatch(/couldn't update the plan draft/i)

    // Still active — the malformed response is not one of the two designed exits.
    const still = await assistant.turn('cancel plan', { sessionId })
    expect(still.reply).toMatch(/stopped drafting/i)
  })
})

describe('plan mode (P6) — self-verification pass before staging', () => {
  it('a dependency cycle in the draft blocks staging even when the model says readyForApproval — fails fast, never silently staged', async () => {
    class CyclicReadyDraftLLMClient implements ILLMClient {
      calls = 0
      async *callChat(): AsyncIterable<string> {
        throw new Error('callChat should never be reached while plan mode is active')
      }
      async callChatSync(): Promise<string> {
        throw new Error('callChatSync should never be reached while plan mode is active')
      }
      async callChatStructured(): Promise<LLMStructuredResponse> {
        this.calls++
        // A drafting revision claiming readyForApproval, but whose own tasks form a cycle — the
        // deterministic dependency-graph check must catch this before it ever reaches
        // PlanApprovalService, regardless of what the model itself claims.
        return {
          content: JSON.stringify({
            reply: 'Here is the plan.',
            success_criteria: 'Both steps are done.',
            rationale: 'Because it works.',
            ready_for_approval: true,
            tasks: [
              { id: 't1', description: 'Task one', depends_on: ['t2'], risk_level: 'LOW' },
              { id: 't2', description: 'Task two', depends_on: ['t1'], risk_level: 'LOW' },
            ],
          }),
        }
      }
    }
    const llm = new CyclicReadyDraftLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'cyclic-session'
    await assistant.enterPlanMode(sessionId)

    const result = await assistant.turn('Looks good, approve it.', { sessionId })

    // Never staged — the LLM's own readyForApproval claim is not enough to pass P6's deterministic
    // gate, so this stays a plain drafting reply, not a needs_plan_approval result.
    expect(result.status).toBe('ok')
    expect(result.reply).toMatch(/structural problem/i)
    expect(result.reply).toMatch(/cycle/i)
    // Exactly one call: the drafting call itself. verifyPlanDraft's graph check is synchronous and
    // fails fast, so the bounded LLM-lens call it would otherwise make is never reached.
    expect(llm.calls).toBe(1)

    // Still drafting — a plain follow-up message goes back through the drafting call again, not
    // treated as staged-for-approval input.
    const followUp = await assistant.turn('please fix that', { sessionId })
    expect(followUp.status).toBe('ok')
    expect(llm.calls).toBe(2)
  })
})

/**
 * First drafting call hits a genuine ambiguity and asks instead of guessing; the second (once the
 * user answers) proceeds to a ready-for-approval draft. Every other callChatStructured call
 * (there shouldn't be any) throws, so any accidental extra call — e.g. a stray tool-loop dispatch
 * — fails the test loudly instead of silently passing.
 */
class NestedAskDraftLLMClient implements ILLMClient {
  calls = 0
  async *callChat(): AsyncIterable<string> {
    throw new Error('callChat should never be reached while plan mode is active')
  }
  async callChatSync(): Promise<string> {
    throw new Error('callChatSync should never be reached while plan mode is active')
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.calls++
    if (this.calls === 1) {
      return {
        content: JSON.stringify({
          reply: 'Which framework should this target?',
          success_criteria: 'The launch ships on time.',
          rationale: 'Depends on the framework choice.',
          ready_for_approval: false,
          tasks: [{ id: 't1', description: 'Research competitors', depends_on: [], risk_level: 'LOW' }],
          question: { id: 'framework-choice', question: 'Which framework should this target?', options: [{ label: 'React' }, { label: 'Vue' }] },
        }),
      }
    }
    if (this.calls === 2) {
      // The answer, formatted, arrives as the newest user message — folded into the *next*
      // drafting revision rather than resuming any harness run (there is none mid-draft).
      const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      return {
        content: JSON.stringify({
          reply: `Great, using: ${userMessage}`,
          success_criteria: 'The launch ships on time.',
          rationale: 'Uses the chosen framework.',
          ready_for_approval: true,
          tasks: [
            { id: 't1', description: 'Research competitors', depends_on: [], risk_level: 'LOW' },
            { id: 't2', description: 'Build with the chosen framework', depends_on: ['t1'], risk_level: 'LOW' },
          ],
        }),
      }
    }
    // P6's self-verification lens call — a plain structured call this client doesn't specially
    // model; returning no `findings` array degrades to an empty reviewNotes list (see
    // reviewPlanForCompleteness's own fail-safe fallback), which is fine for this test's purposes.
    return { content: JSON.stringify({}) }
  }
}

describe('plan mode (P8) — nesting: plan mode can ask a question', () => {
  it(
    'a genuine ambiguity mid-draft stages a nested question; answering folds the answer into the ' +
      'next revision, and the resulting plan is still subject to P2 approval afterward',
    async () => {
      const llm = new NestedAskDraftLLMClient()
      const assistant = new PersonalAssistant({ llmClient: llm })
      const sessionId = 'nested-ask-session'
      await assistant.enterPlanMode(sessionId)

      const asked = await assistant.turn('Plan a product launch.', { sessionId })
      expect(asked.status).toBe('needs_clarification')
      expect(asked.reply).toBeNull()
      expect(asked.pendingClarificationId).toBeTruthy()
      expect(asked.questions).toHaveLength(1)
      expect(asked.questions![0].question).toMatch(/framework/i)
      // INV-30: the question itself cost no extra call beyond the drafting call that raised it —
      // it's an extra field on the same structured response, never a separate tool dispatch.
      expect(llm.calls).toBe(1)

      const response: AskResponse = { answers: [{ questionId: 'framework-choice', kind: 'selected', selectedLabels: ['React'] }] }
      const resolved = await assistant.turn('', { sessionId, pendingClarificationId: asked.pendingClarificationId, clarificationAnswer: response })

      // Nesting an ask never substitutes for P2's mandatory whole-plan approval gate.
      expect(resolved.status).toBe('needs_plan_approval')
      expect(resolved.planApprovalId).toBeTruthy()
      expect(resolved.planApproval?.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
      // The answer-folded revision call, plus P6's own verification call — still no tool call anywhere.
      expect(llm.calls).toBe(3)
    },
  )

  it('fails closed when no answer is provided — the question stays pending, not silently dropped', async () => {
    const llm = new NestedAskDraftLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'nested-ask-no-answer'
    await assistant.enterPlanMode(sessionId)
    const asked = await assistant.turn('Plan a product launch.', { sessionId })

    const resolved = await assistant.turn('', { sessionId, pendingClarificationId: asked.pendingClarificationId })
    expect(resolved.status).toBe('needs_clarification')
    expect(resolved.reason).toMatch(/no answer/i)
    expect(resolved.pendingClarificationId).toBe(asked.pendingClarificationId)
    expect(llm.calls).toBe(1)
  })

  it('rejects an answer that does not validate against the staged question (INV-28) — fails closed, not coerced', async () => {
    const llm = new NestedAskDraftLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'nested-ask-invalid-answer'
    await assistant.enterPlanMode(sessionId)
    const asked = await assistant.turn('Plan a product launch.', { sessionId })

    const badResponse: AskResponse = { answers: [{ questionId: 'not-the-staged-question', kind: 'selected', selectedLabels: ['React'] }] }
    const resolved = await assistant.turn('', { sessionId, pendingClarificationId: asked.pendingClarificationId, clarificationAnswer: badResponse })
    expect(resolved.status).toBe('needs_clarification')
    expect(llm.calls).toBe(1)
  })

  it('a stale/unknown pendingClarificationId resolves to a no-op ok, not an error', async () => {
    const llm = new NestedAskDraftLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })
    const sessionId = 'nested-ask-stale'
    await assistant.enterPlanMode(sessionId)
    await assistant.turn('Plan a product launch.', { sessionId })

    const resolved = await assistant.turn('', { sessionId, pendingClarificationId: 'not-a-real-id', clarificationAnswer: { answers: [] } })
    expect(resolved.status).toBe('ok')
    expect(resolved.reply).toMatch(/no longer pending/i)
  })
})
