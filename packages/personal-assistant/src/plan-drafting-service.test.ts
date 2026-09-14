import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition, FsBackend } from '@buildaharness/runtime'
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

const TURN_INTENT_MARKER = 'seven independent judgments'

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
