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
const ask = async (reply: string | Error, over: { message?: string; lastReply?: string } = {}) =>
  (await readWriterIntent({ message: over.message ?? 'revise the outline', articleHasText: true, lastReply: over.lastReply }, client(reply))).intent

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
  it('returns the web addresses the model found, parsed and without repeats, and drops anything else', async () => {
    const r = await readWriterIntent(
      { message: 'like https://a.test/post', articleHasText: true },
      client(JSON.stringify({ intent: 'rewrite', links: ['https://a.test/post', ' https://a.test/post ', 'not a link', 'ftp://x.test/f', 7, 'http://b.test/x'] })),
    )
    expect(r).toEqual({ intent: 'rewrite', links: ['https://a.test/post', 'http://b.test/x'], scope: 'text' })
  })
  it('keeps at most three addresses and none when the model gives none or the call fails', async () => {
    const many = JSON.stringify({ intent: 'edit', links: ['https://1.test/', 'https://2.test/', 'https://3.test/', 'https://4.test/'] })
    expect((await readWriterIntent({ message: 'm', articleHasText: true }, client(many))).links).toHaveLength(3)
    expect((await readWriterIntent({ message: 'm', articleHasText: true }, client('{"intent":"edit"}'))).links).toEqual([])
    expect(await readWriterIntent({ message: 'm', articleHasText: true }, client(new Error('x')))).toEqual({ intent: 'answer', links: [], scope: 'text' })
  })
  it('gives the model the last reply, clipped, and whether the article has text', async () => {
    const seen: { content: string }[][] = []
    await readWriterIntent({ message: 'yes, apply that', articleHasText: false, lastReply: 'x'.repeat(5000) }, client('{"intent":"edit"}', seen))
    const body = JSON.parse(seen[0][1].content)
    expect(body.articleHasText).toBe(false)
    expect(body.assistantLastReply).toHaveLength(1500)
  })
  it('says what an edit changes: the headings, the wording or both, and the wording when it is not clear', async () => {
    const read = async (reply: unknown) => (await readWriterIntent({ message: 'm', articleHasText: true }, client(JSON.stringify(reply)))).scope
    expect(await read({ intent: 'edit', links: [], scope: 'outline' })).toBe('outline')
    expect(await read({ intent: 'edit', links: [], scope: 'both' })).toBe('both')
    expect(await read({ intent: 'edit', links: [], scope: 'text' })).toBe('text')
    expect(await read({ intent: 'edit', links: [] })).toBe('text')
    expect(await read({ intent: 'edit', links: [], scope: 'everything' })).toBe('text')
  })
})
