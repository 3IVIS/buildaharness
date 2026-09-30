import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { checkConstraints, semanticConstraintCheckEnabled } from './constraint-check.js'
import { SIDE_CALL_MARKERS } from './scripted-llm-client.js'

class StubClient implements ILLMClient {
  calls: ChatMessage[][] = []
  constructor(private readonly content: string | Error) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.calls.push(messages)
    if (this.content instanceof Error) throw this.content
    return { content: this.content }
  }
}

const input = { constraints: ['Do not use tabs', 'Keep it under 100 words'], reply: 'I will not use tabs; spaces only.' }

describe('checkConstraints', () => {
  it('returns the violations the model names, with the reason', async () => {
    const llm = new StubClient(JSON.stringify({ violations: [{ constraint: 'Do not use tabs', reason: 'indents with a tab' }] }))
    expect(await checkConstraints(input, llm)).toEqual({ violated: [{ constraint: 'Do not use tabs', reason: 'indents with a tab' }] })
  })

  it('sends the constraints and the reply, and the prompt says an acknowledging reply is not a violation', async () => {
    const llm = new StubClient('{"violations":[]}')
    await checkConstraints(input, llm)
    const [system, user] = llm.calls[0]
    expect(system.content).toContain('is NOT a violation')
    expect(JSON.parse(user.content)).toEqual(input)
  })

  it('drops a constraint the model invented (only what the caller set can be reported)', async () => {
    const llm = new StubClient(JSON.stringify({ violations: [{ constraint: 'Never mention Paris', reason: 'x' }] }))
    expect(await checkConstraints(input, llm)).toEqual({ violated: [] })
  })

  it('fails open on an error, an unparseable answer, a wrong shape, and needs no call for nothing to check', async () => {
    expect(await checkConstraints(input, new StubClient(new Error('down')))).toEqual({ violated: [] })
    expect(await checkConstraints(input, new StubClient('not json at all'))).toEqual({ violated: [] })
    expect(await checkConstraints(input, new StubClient('{"violations":"yes"}'))).toEqual({ violated: [] })
    const idle = new StubClient('{"violations":[{"constraint":"Do not use tabs"}]}')
    expect(await checkConstraints({ constraints: [], reply: 'x' }, idle)).toEqual({ violated: [] })
    expect(await checkConstraints({ constraints: ['Do not use tabs'], reply: '  ' }, idle)).toEqual({ violated: [] })
    expect(idle.calls).toHaveLength(0)
  })
})

describe('AUDIT_SEMANTIC_CONSTRAINT_CHECK', () => {
  it('is on unless explicitly turned off', () => {
    expect(semanticConstraintCheckEnabled({})).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) expect(semanticConstraintCheckEnabled({ AUDIT_SEMANTIC_CONSTRAINT_CHECK: v })).toBe(false)
    expect(semanticConstraintCheckEnabled({ AUDIT_SEMANTIC_CONSTRAINT_CHECK: '1' })).toBe(true)
  })

  it('the scripted client answers this call inertly instead of consuming a tool-loop slot', () => {
    const marker = SIDE_CALL_MARKERS.find(([m]) => "You judge whether an assistant's reply violates constraints the user set. x".includes(m))
    expect(marker?.[1]).toBe('{"violations":[]}')
  })
})
