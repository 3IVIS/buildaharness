import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { checkAnswers, locateExcerpt, verifyBatchWithTools } from './repo-verify-loop.js'
import { createRepoIndex } from './repo-search.js'

const idx = createRepoIndex(new Map([['src/a.ts', 'line one\nexport const DELAY_MS = 800\n\nexport const LIMIT = 5000\n']]))

function scripted(replies: LLMStructuredResponse[]): { llm: ILLMClient; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  const llm = { callChatStructured: async (m: ChatMessage[]) => { seen.push(m.map((x) => ({ ...x }))); const r = replies.shift(); if (!r) throw new Error('script ran out'); return r } } as unknown as ILLMClient
  return { llm, seen }
}
const answer = (rows: unknown[]): LLMStructuredResponse => ({ content: '```json\n' + JSON.stringify(rows) + '\n```' })

describe('locating a quote in a file', () => {
  it('finds it despite spacing and case, with its line numbers', () => {
    expect(locateExcerpt(idx.text('src/a.ts') as string, 'EXPORT const   delay_ms = 800')).toEqual({ from: 2, to: 2 })
    expect(locateExcerpt(idx.text('src/a.ts') as string, 'DELAY_MS = 800 ... LIMIT = 5000')).toEqual({ from: 2, to: 4 })
  })
  it('refuses words that are not in the file', () => {
    expect(locateExcerpt(idx.text('src/a.ts') as string, 'export const DELAY_MS = 900')).toBeUndefined()
    expect(locateExcerpt('abc', 'short')).toBeUndefined()
  })
})

describe('checking the model answers', () => {
  it('keeps only quotes found in their file and recomputes the lines itself', () => {
    const [ok, fake, missing] = checkAnswers(['k1', 'k2', 'k3'], [
      { id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/a.ts:99-99', excerpt: 'export const DELAY_MS = 800' }] },
      { id: 'k2', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/a.ts', excerpt: 'export const DELAY_MS = 1' }] },
    ], idx)
    expect(ok).toMatchObject({ verdict: 'supported', evidence: [{ file: 'src/a.ts', from: 2, to: 2 }] })
    expect(ok.problem).toBeUndefined()
    expect(fake.problem).toMatch(/not found in src\/a.ts/)
    expect(missing.problem).toBe('no answer for this claim')
  })
  it('accepts not_supported and not_about_code without a quote', () => {
    const [a, b] = checkAnswers(['k1', 'k2'], [{ id: 'k1', verdict: 'not_supported', reason: 'x', searched: ['grep foo'] }, { id: 'k2', verdict: 'not_about_code', reason: 'y' }], idx)
    expect(a.problem).toBeUndefined()
    expect(b.problem).toBeUndefined()
  })
})

describe('the lookup loop', () => {
  it('runs the lookups the model asks for, feeds them back, and returns the checked answer', async () => {
    const { llm, seen } = scripted([
      { content: '', toolCalls: [{ id: 't1', name: 'search', input: { pattern: 'DELAY' } }] },
      answer([{ id: 'k1', verdict: 'supported', reason: 'ok', evidence: [{ file: 'src/a.ts', excerpt: 'export const DELAY_MS = 800' }] }]),
    ])
    const steps: string[] = []
    const out = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'It waits 800 ms.' }], articleText: 'It waits 800 ms.' }, idx, llm, { onStep: (s) => steps.push(s.tool) })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'k1', verdict: 'supported' })
    expect(steps).toEqual(['search'])
    const toolMessage = seen[1].find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('src/a.ts:2: export const DELAY_MS = 800')
    expect(toolMessage?.content).toContain('<untrusted_external_content>')
  })
  it('sends only the unsettled claims back in the same conversation, once', async () => {
    const { llm, seen } = scripted([
      answer([{ id: 'k1', verdict: 'supported', reason: 'ok', evidence: [{ file: 'src/a.ts', excerpt: 'export const DELAY_MS = 800' }] }, { id: 'k2', verdict: 'supported', reason: 'ok', evidence: [{ file: 'src/a.ts', excerpt: 'made up words here' }] }]),
      answer([{ id: 'k2', verdict: 'supported', reason: 'now', evidence: [{ file: 'src/a.ts', excerpt: 'export const LIMIT = 5000' }] }]),
    ])
    const out = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'a' }, { id: 'k2', quote: 'b' }], articleText: '' }, idx, llm)
    expect(out.map((r) => [r.id, r.problem])).toEqual([['k1', undefined], ['k2', undefined]])
    expect(out[1].reason).toBe('now')
    const followUp = seen[1].at(-1)?.content ?? ''
    expect(followUp).toContain('k2: b')
    expect(followUp).not.toContain('k1: a')
    expect(seen[1].slice(0, 2)).toEqual(seen[0].slice(0, 2))
  })
  it('asks once more when the final reply cannot be read as the answer', async () => {
    const { llm, seen } = scripted([{ content: 'I will look at the repository first.' }, answer([{ id: 'k1', verdict: 'not_supported', reason: 'none', searched: ['x'] }])])
    const out = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'a' }], articleText: '' }, idx, llm)
    expect(out[0]).toMatchObject({ id: 'k1', verdict: 'not_supported' })
    expect(out[0].problem).toBeUndefined()
    expect(seen[1].at(-1)?.content).toContain('could not be read')
  })
  it('stops running lookups past the cap and tells the model to answer', async () => {
    const call = (n: number): LLMStructuredResponse => ({ content: '', toolCalls: [{ id: `t${n}`, name: 'list', input: {} }] })
    const { llm, seen } = scripted([call(1), call(2), answer([{ id: 'k1', verdict: 'not_supported', reason: 'none', searched: ['x'] }])])
    const out = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'a' }], articleText: '' }, idx, llm, { maxToolCalls: 1 })
    expect(out[0].verdict).toBe('not_supported')
    expect(seen[2].filter((m) => m.role === 'tool').at(-1)?.content).toContain('No more lookups')
  })
})

describe('a backend without native tool calls (claude -p)', () => {
  it('asks for lookups as JSON text, runs them, and reads the final answer', async () => {
    const index = createRepoIndex(new Map([['src/save.ts', 'export const SAVE_DELAY_MS = 800\n']]))
    const sent: string[] = []
    const replies = ['{"tool_calls":[{"name":"search","input":{"pattern":"DELAY"}}]}', '<invoke name="read"><parameter name="path">src/save.ts</parameter></invoke>', JSON.stringify([{ id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/save.ts', excerpt: 'SAVE_DELAY_MS = 800' }] }])]
    const llm = {
      nativeToolCalls: false,
      callChatStructured: async () => { throw new Error('must not be called with tools') },
      callChatSync: async (m: { content: string }[]) => { sent.push(m.map((x) => x.content).join('\n')); return replies.shift() ?? '' },
    } as unknown as ILLMClient
    const [r] = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'Write waits 800 ms.' }], articleText: 'x' }, index, llm)
    expect(r).toMatchObject({ id: 'k1', verdict: 'supported', evidence: [{ file: 'src/save.ts', from: 1, to: 1 }] })
    expect(sent[0]).toContain('TOOL PROTOCOL')
    expect(sent[1]).toContain('src/save.ts:1: export const SAVE_DELAY_MS = 800')
    expect(sent[2]).toContain('1: export const SAVE_DELAY_MS = 800')
  })
})

describe('over the OpenAI-compatible client (OpenAI, OpenRouter)', () => {
  it('runs the lookups through native tool_calls and reports the answer', async () => {
    const { OpenAICompatibleLLMClient } = await import('@buildaharness/runtime')
    const index = createRepoIndex(new Map([['src/save.ts', 'export const SAVE_DELAY_MS = 800\n']]))
    const answer = JSON.stringify([{ id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/save.ts', excerpt: 'SAVE_DELAY_MS = 800' }] }])
    const bodies: { messages: { role: string; tool_call_id?: string }[]; tools?: unknown[] }[] = []
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"pattern":"DELAY"}' } }] } }] },
      { choices: [{ message: { content: answer } }] },
    ]
    const fetchImpl = (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(replies.shift())) }) as unknown as typeof fetch
    const llm = new OpenAICompatibleLLMClient({ apiKey: 'k', baseUrl: 'https://example.test/v1', defaultModel: 'm', fetchImpl })
    const [r] = await verifyBatchWithTools({ claims: [{ id: 'k1', quote: 'Write waits 800 ms.' }], articleText: 'x' }, index, llm)
    expect(r).toMatchObject({ id: 'k1', verdict: 'supported' })
    expect(bodies[0].tools).toHaveLength(3)
    expect(bodies[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true)
  })
})
