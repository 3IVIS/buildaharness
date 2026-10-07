import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { gateLlmClient, raceAbort, TurnAbortedError, type AbortGate } from './turn-abort.js'

/** Wraps a client so each call parks until `release()`; counts calls that actually started. */
function parkedClient(inner: ILLMClient) {
  let started = 0
  let release: () => void = () => undefined
  let parked = new Promise<void>((r) => { release = r })
  const wait = async (): Promise<void> => { started++; await parked }
  const client: ILLMClient = {
    async *callChat(m: ChatMessage[], o?: ChatOptions) { await wait(); yield* inner.callChat(m, o) },
    async callChatSync(m: ChatMessage[], o?: ChatOptions) { await wait(); return inner.callChatSync(m, o) },
    async callChatStructured(m: ChatMessage[], t?: ToolDefinition[], o?: ChatOptions): Promise<LLMStructuredResponse> { await wait(); return inner.callChatStructured(m, t, o) },
  }
  return { client, started: () => started, release: () => { release(); parked = Promise.resolve() } }
}

describe('turn abort', () => {
  it('gateLlmClient refuses calls and discards results once the signal aborted', async () => {
    const ac = new AbortController()
    const gate: AbortGate = { signal: ac.signal }
    const inner = createScriptedLLMClient({ responses: ['hi'] })
    const gated = gateLlmClient(inner, gate)
    ac.abort()
    await expect(gated.callChatSync([])).rejects.toBeInstanceOf(TurnAbortedError)
    gate.signal = undefined
    await expect(gated.callChatSync([])).resolves.toBeDefined()
  })

  it('raceAbort rejects at once and swallows the late outcome', async () => {
    const ac = new AbortController()
    const never = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late')), 20))
    const p = raceAbort(never, ac.signal)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(TurnAbortedError)
    await new Promise((r) => setTimeout(r, 40))
  })

  it('Stop mid-turn resolves cancelled, leaves the transcript untouched, and the assistant still works afterwards', async () => {
    const parked = parkedClient(createScriptedLLMClient({ responses: ['first answer', 'second answer'], streamChunks: ['ok'] }))
    const pa = new PersonalAssistant({ llmClient: parked.client, model: 'm' })
    const ac = new AbortController()
    const turn = pa.turn('Tell me something', { sessionId: 's', signal: ac.signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(parked.started()).toBeGreaterThan(0)
    ac.abort()
    const result = await turn
    expect(result.status).toBe('cancelled')
    expect(result.reply).toBeNull()
    parked.release()
    await new Promise((r) => setTimeout(r, 20))
    expect(await pa.getTranscript('s')).toEqual([])
    const next = await pa.turn('Try again', { sessionId: 's' })
    expect(next.status).toBe('ok')
  })

  it('an already-aborted signal cancels before any model call', async () => {
    const parked = parkedClient(createScriptedLLMClient({ responses: ['x'] }))
    const pa = new PersonalAssistant({ llmClient: parked.client, model: 'm' })
    const ac = new AbortController()
    ac.abort()
    const result = await pa.turn('hello', { sessionId: 's', signal: ac.signal })
    expect(result.status).toBe('cancelled')
    expect(parked.started()).toBe(0)
  })
})
