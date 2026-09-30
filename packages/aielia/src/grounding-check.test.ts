import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { checkReplyGrounding, semanticGroundingEnabled } from './grounding-check.js'
import type { AssistantSource } from './assistant-source.js'

function client(content: string | Error, seen: { messages?: { role: string; content: string }[] } = {}): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.messages = messages
      if (content instanceof Error) throw content
      return { content }
    },
  } as unknown as ILLMClient
}

const SOURCES: AssistantSource[] = [{ tool: 'read_file', path: 'q3.md', excerpt: '- Hosting: 412\n- Tooling: 287\nTotal: 4058' }]
const INPUT = { question: 'What is the total?', reply: 'The total is 4058.', sources: SOURCES }

describe('checkReplyGrounding', () => {
  it('returns grounded / ungrounded (with the discrepancy) from the model verdict', async () => {
    expect(await checkReplyGrounding(INPUT, client('{"verdict":"grounded"}'))).toEqual({ verdict: 'grounded' })
    expect(await checkReplyGrounding(INPUT, client('{"verdict":"ungrounded","discrepancy":"sum is 699"}'))).toEqual({ verdict: 'ungrounded', discrepancy: 'sum is 699' })
  })

  it('passes the raw tool text, untrusted-wrapped, and the reply to the model', async () => {
    const seen: { messages?: { role: string; content: string }[] } = {}
    await checkReplyGrounding(INPUT, client('{"verdict":"grounded"}', seen))
    const user = seen.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('Total: 4058')
    expect(user).toContain('untrusted_external_content')
    expect(user).toContain('The total is 4058.')
  })

  it('takes the JSON verdict even when the model reasons in prose first', async () => {
    const prose = 'Sum: 412+287=699.\nThe reply is off.\n\n{"verdict": "ungrounded", "discrepancy": "sum is 699"}'
    expect(await checkReplyGrounding(INPUT, client(prose))).toEqual({ verdict: 'ungrounded', discrepancy: 'sum is 699' })
  })

  it('is not_checked, without calling the model, when no tool text is visible', async () => {
    const seen: { messages?: unknown } = {}
    expect(await checkReplyGrounding({ ...INPUT, sources: [{ tool: 'read_file', path: 'q3.md' }] }, client('{"verdict":"grounded"}', seen as never))).toEqual({ verdict: 'not_checked' })
    expect(await checkReplyGrounding({ ...INPUT, sources: undefined }, client('{"verdict":"grounded"}', seen as never))).toEqual({ verdict: 'not_checked' })
    expect(seen.messages).toBeUndefined()
  })

  it('is not_checked — never a guessed "grounded" — on an LLM error or an unparseable/unknown verdict', async () => {
    expect(await checkReplyGrounding(INPUT, client(new Error('boom')))).toEqual({ verdict: 'not_checked' })
    expect(await checkReplyGrounding(INPUT, client('not json'))).toEqual({ verdict: 'not_checked' })
    expect(await checkReplyGrounding(INPUT, client('{"verdict":"maybe"}'))).toEqual({ verdict: 'not_checked' })
  })
})

describe('semanticGroundingEnabled', () => {
  it('defaults ON and turns off on a falsy value', () => {
    expect(semanticGroundingEnabled({})).toBe(true)
    expect(semanticGroundingEnabled({ AUDIT_SEMANTIC_GROUNDING: 'off' })).toBe(false)
    expect(semanticGroundingEnabled({ AUDIT_SEMANTIC_GROUNDING: '0' })).toBe(false)
    expect(semanticGroundingEnabled({ AUDIT_SEMANTIC_GROUNDING: '1' })).toBe(true)
  })
})
