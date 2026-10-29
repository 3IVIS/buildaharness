import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { readWriterIntent } from './writer-intent.js'

function client(reply: string | Error, seen: unknown[] = []): ILLMClient {
  return {
    callChatStructured: async (messages: unknown) => {
      seen.push(messages)
      if (reply instanceof Error) throw reply
      return { content: reply }
    },
  } as unknown as ILLMClient
}
const ask = (reply: string | Error, over: { message?: string; lastReply?: string } = {}) =>
  readWriterIntent({ message: over.message ?? 'revise the outline', articleHasText: true, lastReply: over.lastReply }, client(reply))

describe('readWriterIntent', () => {
  it('returns what the model judged', async () => {
    expect(await ask('{"intent":"edit"}')).toBe('edit')
    expect(await ask('{"intent":"rewrite"}')).toBe('rewrite')
    expect(await ask('{"intent":"suggest"}')).toBe('suggest')
    expect(await ask('{"intent":"answer"}')).toBe('answer')
  })
  it('treats anything unusable as an answer', async () => {
    expect(await ask('{"intent":"delete everything"}')).toBe('answer')
    expect(await ask('not json')).toBe('answer')
    expect(await ask(new Error('503'))).toBe('answer')
    expect(await ask('{"intent":"edit"}', { message: '   ' })).toBe('answer')
  })
  it('gives the model the last reply, clipped, and whether the article has text', async () => {
    const seen: { content: string }[][] = []
    await readWriterIntent({ message: 'yes, apply that', articleHasText: false, lastReply: 'x'.repeat(5000) }, client('{"intent":"edit"}', seen))
    const body = JSON.parse(seen[0][1].content)
    expect(body.articleHasText).toBe(false)
    expect(body.assistantLastReply).toHaveLength(1500)
  })
})
