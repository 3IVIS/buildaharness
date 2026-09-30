import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// The semantic change reviewer is ADVISORY. On a tool-less turn the reply is already drafted (and
// streamed) before the harness runs, so nothing can read a review note — the conflict must reach
// the user as `reviewNotice`, and the turn must still complete with its draft reply intact.

const POLICY = 'the organization limits every supplier arrangement to a year at most'
const REASON = 'a three-year agreement exceeds the twelve-month supplier cap'

/** Wraps the scripted client: answers the reviewer / contradiction side calls from canned JSON so they never consume a scripted slot, and counts reviewer calls. */
function clientWithReviewer(verdict: { conflict: boolean; reason?: string }) {
  const inner = createScriptedLLMClient({
    responses: [],
    streamChunks: ['Sure — here is a catering plan.'],
    classify: (m) => (m.includes('at most')
      ? { statesDurableFacts: [{ text: POLICY, durable: true, confidence: 'high', category: 'other' }] }
      : undefined),
  })
  const seen = { reviewerCalls: 0, reviewerInput: '' }
  const client: ILLMClient = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => inner.callChat(m, o),
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      const system = messages.find((x) => x.role === 'system')?.content ?? ''
      if (system.includes('You check whether a proposed action genuinely conflicts')) {
        seen.reviewerCalls++
        seen.reviewerInput = messages.find((x) => x.role === 'user')?.content ?? ''
        return { content: JSON.stringify(verdict) }
      }
      if (system.includes("You check a personal assistant's beliefs")) {
        return { content: '{"contradictions":[],"corroborations":[]}' }
      }
      return inner.callChatStructured(messages, tools, options)
    },
  } as ILLMClient
  return { client, seen }
}

describe('semantic change review is advisory', () => {
  // The lexical checks are being rolled back: run with them off, so the semantic reviewer is the
  // only conflict check and the lexical coding-fact gate ("Build …" reads as code) never skips it.
  const prev = process.env.ASSISTANT_LEXICAL_MODE
  beforeEach(() => { process.env.ASSISTANT_LEXICAL_MODE = 'disabled' })
  afterEach(() => {
    if (prev === undefined) delete process.env.ASSISTANT_LEXICAL_MODE
    else process.env.ASSISTANT_LEXICAL_MODE = prev
  })

  it('surfaces a conflict as reviewNotice, keeps the drafted reply, and completes the turn', async () => {
    const { client, seen } = clientWithReviewer({ conflict: true, reason: REASON })
    const assistant = new PersonalAssistant({ llmClient: client })

    await assistant.turn('With suppliers we keep every arrangement to a year at most.', { sessionId: 'advisory-1' })
    const second = await assistant.turn("Build the offsite catering plan around the caterer's three-year agreement.", { sessionId: 'advisory-1' })

    expect(seen.reviewerCalls).toBe(1) // once — not once per retry
    expect(seen.reviewerInput).toContain(POLICY)
    expect(second.status).toBe('ok')
    expect(second.reply).toBe('Sure — here is a catering plan.')
    expect(second.reviewNotice).toContain('Heads up')
    expect(second.reviewNotice).toContain(REASON)
  })

  it('sets no notice when the reviewer finds no conflict', async () => {
    const { client } = clientWithReviewer({ conflict: false })
    const assistant = new PersonalAssistant({ llmClient: client })

    await assistant.turn('With suppliers we keep every arrangement to a year at most.', { sessionId: 'advisory-2' })
    const second = await assistant.turn('Plan a one-year catering arrangement for the offsite.', { sessionId: 'advisory-2' })

    expect(second.status).toBe('ok')
    expect(second.reviewNotice).toBeUndefined()
  })

  it('does not call the reviewer at all when nothing trusted is known yet (no extra LLM call)', async () => {
    const { client, seen } = clientWithReviewer({ conflict: true, reason: REASON })
    const assistant = new PersonalAssistant({ llmClient: client })

    const only = await assistant.turn("Build the offsite catering plan around the caterer's three-year agreement.", { sessionId: 'advisory-3' })

    expect(seen.reviewerCalls).toBe(0)
    expect(only.reviewNotice).toBeUndefined()
  })
})
