import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { semanticCompactionEnabled, summarizeOlderMessages } from './semantic-compaction.js'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

class Stub implements ILLMClient {
  calls: ChatMessage[][] = []
  constructor(private readonly content: string | Error) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(m: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.calls.push(m)
    if (this.content instanceof Error) throw this.content
    return { content: this.content }
  }
}
const older: ChatMessage[] = [{ role: 'user', content: 'Contract auto-renews 14 March.' }, { role: 'assistant', content: 'Noted.' }]

describe('summarizeOlderMessages', () => {
  it('returns the summary and sends the messages, with a prompt that asks to keep specifics', async () => {
    const llm = new Stub('{"summary":"  Renewal is 14 March. "}')
    expect(await summarizeOlderMessages(older, llm)).toBe('Renewal is 14 March.')
    expect(llm.calls[0][0].content).toContain('names, numbers, dates')
    expect(JSON.parse(llm.calls[0][1].content).messages).toEqual(older)
  })

  it('null on an error, an empty or missing summary, unparseable text, no messages, or input too large to send', async () => {
    expect(await summarizeOlderMessages(older, new Stub(new Error('down')))).toBeNull()
    expect(await summarizeOlderMessages(older, new Stub('{"summary":"  "}'))).toBeNull()
    expect(await summarizeOlderMessages(older, new Stub('{"other":1}'))).toBeNull()
    expect(await summarizeOlderMessages(older, new Stub('not json'))).toBeNull()
    const idle = new Stub('{"summary":"x"}')
    expect(await summarizeOlderMessages([], idle)).toBeNull()
    const huge = Array.from({ length: 12 }, () => ({ role: 'user' as const, content: 'y'.repeat(20_000) }))
    expect(await summarizeOlderMessages(huge, idle)).toBeNull()
    expect(idle.calls).toHaveLength(0)
  })

  it('caps the summary length', async () => {
    const r = await summarizeOlderMessages(older, new Stub(JSON.stringify({ summary: 'z'.repeat(20_000) })))
    expect(r?.length).toBe(8000)
  })
})

describe('AUDIT_SEMANTIC_COMPACTION', () => {
  it('is off unless explicitly turned on', () => {
    expect(semanticCompactionEnabled({})).toBe(false)
    expect(semanticCompactionEnabled({ AUDIT_SEMANTIC_COMPACTION: '0' })).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled']) expect(semanticCompactionEnabled({ AUDIT_SEMANTIC_COMPACTION: v })).toBe(true)
  })
})

// End to end through PersonalAssistant: a detail deep in an early, long message, then enough turns to compact it away.
describe('through the assistant', () => {
  const FACT = 'the vendor contract auto-renews on 14 March unless cancelled 60 days before'
  const filler = (n: number, tag: string) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n)
  const doc = `Meeting notes.\n${filler(3000, 'discussion')}\nDecision: ${FACT}.\n${filler(3000, 'followup')}`
  const messages = [doc, `Other notes: ${filler(9000, 'alpha')}`, `More notes: ${filler(9000, 'beta')}`, 'thanks', 'ok next', 'and another', 'one more', 'fine', 'right', 'good', 'sure', 'When does the vendor contract renew?']

  async function lastPrompt(summaryReply: string | undefined, flag: boolean): Promise<string> {
    const prior = process.env.AUDIT_SEMANTIC_COMPACTION
    if (flag) process.env.AUDIT_SEMANTIC_COMPACTION = '1'
    else delete process.env.AUDIT_SEMANTIC_COMPACTION
    try {
      const inner = createScriptedLLMClient({
        responses: Array.from({ length: 30 }, (_, i) => `ok ${i}`),
        streamChunks: ['ok'],
        classify: () => ({ isTrivial: false }),
        ...(summaryReply === undefined ? {} : { sideResponses: [['You condense the earlier part of a conversation', summaryReply] as [string, string]] }),
      })
      const seen: ChatMessage[][] = []
      const llm: ILLMClient = {
        callChat: (m, o) => { seen.push(m); return inner.callChat(m, o) },
        callChatSync: (m, o) => { seen.push(m); return inner.callChatSync(m, o) },
        callChatStructured: async (m, t, o) => { seen.push(m); return inner.callChatStructured(m, t, o) },
      }
      const a = new PersonalAssistant({ llmClient: llm, checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'c' }), oneLoopMode: 'enabled' })
      for (const [i, m] of messages.entries()) {
        seen.length = 0
        await a.turn(m, { sessionId: 'compact' })
        if (i === messages.length - 1) return seen.flat().map((x) => x.content).join('\n')
      }
      return ''
    } finally {
      if (prior === undefined) delete process.env.AUDIT_SEMANTIC_COMPACTION
      else process.env.AUDIT_SEMANTIC_COMPACTION = prior
    }
  }

  it('off (default): the detail past the first 200 characters is gone from what the model is sent (the failure this layer addresses)', async () => {
    const prompt = await lastPrompt(undefined, false)
    expect(prompt).toContain('[Earlier conversation summary]')
    expect(prompt).not.toContain('auto-renews on 14 March')
  })

  it('on: the summary the model wrote replaces the truncated lines, so the detail reaches the last turn', async () => {
    const prompt = await lastPrompt(JSON.stringify({ summary: `Vendor contract: ${FACT}.` }), true)
    expect(prompt).toContain('[Earlier conversation summary]\nVendor contract: the vendor contract auto-renews on 14 March')
  })

  it('on, but the summarizer gives nothing usable: exactly the off behaviour', async () => {
    const prompt = await lastPrompt('{"summary":""}', true)
    expect(prompt).toContain('[Earlier conversation summary]')
    expect(prompt).not.toContain('auto-renews on 14 March')
  })
})
