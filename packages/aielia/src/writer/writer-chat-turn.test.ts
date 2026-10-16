import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type ILLMClient } from '@buildaharness/runtime'
import { createMemoryWriterChatPort, processWriterMessage } from './writer-chat-turn.js'

const ARTICLES = [{ id: 'bakery', title: 'Bakery post' }, { id: 'garden', title: 'Seed swap' }]
const mem = () => new InMemoryAdapter({ scope: 'thread', namespace: 'writer-test' })
const port = (m = mem(), articles = ARTICLES) => createMemoryWriterChatPort(m, () => articles)
function client(replies: (string | Error)[]): ILLMClient {
  let i = 0
  return {
    callChatStructured: async () => {
      const r = replies[Math.min(i++, replies.length - 1)]
      if (r instanceof Error) throw r
      return { content: r }
    },
  } as unknown as ILLMClient
}
const add = (label: string, text: string) => ({ op: 'add_comment', label, reviewer: 'Dana', text })

describe('processWriterMessage', () => {
  it('stores captured items per article and returns a block for the active one', async () => {
    const p = port()
    const block = await processWriterMessage({ message: 'comments', port: p }, client([JSON.stringify({ articleId: 'bakery', ops: [add('C1', 'Check the figure'), add('C2', 'Remove the sentence')] })]))
    expect(block).toContain('Bakery post')
    expect(block).toContain('comment C1')
    expect((await p.load()).comments).toHaveLength(2)
    expect(await p.getActive()).toBe('bakery')
  })

  it('keeps the state when the work resumes later: a message that adds nothing still gets the block', async () => {
    const p = port()
    await processWriterMessage({ message: 'comments', port: p }, client([JSON.stringify({ articleId: 'bakery', ops: [add('C4', 'Cost first')] })]))
    const block = await processWriterMessage({ message: 'Show me the final text.', port: p }, client([JSON.stringify({ articleId: null, ops: [] })]))
    expect(block).toContain('comment C4')
  })

  it('keeps other articles out of the block', async () => {
    const p = port()
    await processWriterMessage({ message: 'a', port: p }, client([JSON.stringify({ articleId: 'garden', ops: [add('G1', 'Give a date')] })]))
    const block = await processWriterMessage({ message: 'b', port: p }, client([JSON.stringify({ articleId: 'bakery', ops: [add('C1', 'Fix')] })]))
    expect(block).toContain('comment C1')
    expect(block).not.toContain('G1')
  })

  it('holds the items and tells the assistant to ask when the article is unclear, then files them once the writer answers', async () => {
    const p = port()
    const first = await processWriterMessage({ message: 'it is 41 ms', port: p }, client([JSON.stringify({ articleId: null, ops: [{ op: 'add_correction', note: 'p99 is 41 ms' }] })]))
    expect(first).toContain('Ask which article')
    expect((await p.load()).corrections).toHaveLength(0)
    expect(await p.getPending()).toHaveLength(1)
    const second = await processWriterMessage({ message: 'the bakery one', port: p }, client([JSON.stringify({ articleId: 'bakery', ops: [] })]))
    expect(second).toContain('p99 is 41 ms')
    expect((await p.load()).corrections[0].articleId).toBe('bakery')
    expect(await p.getPending()).toBeUndefined()
  })

  it('tells the assistant not to claim it saved anything when the capture fails, and changes nothing', async () => {
    const p = port()
    await processWriterMessage({ message: 'a', port: p }, client([JSON.stringify({ articleId: 'bakery', ops: [add('C1', 'Fix')] })]))
    const block = await processWriterMessage({ message: 'b', port: p }, client([new Error('503')]))
    expect(block).toContain('could not record')
    expect((await p.load()).comments).toHaveLength(1)
  })

  it('never throws, even when the port does', async () => {
    const broken = { ...port(), load: async () => { throw new Error('disk') } }
    expect(await processWriterMessage({ message: 'a', port: broken }, client(['{}']))).toContain('could not record')
  })
})
