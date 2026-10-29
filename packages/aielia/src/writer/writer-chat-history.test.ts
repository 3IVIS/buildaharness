import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient } from '@buildaharness/runtime'
import { chatHistoryMessages } from './writer-chat-history.js'
import { suggestEdits } from './article-edit-suggest.js'
import { createArticleMeta } from './article-model.js'

describe('chatHistoryMessages', () => {
  it('alternates writer and assistant, starts with the writer and ends with the assistant', () => {
    const m = chatHistoryMessages([
      { from: 'aielia', text: 'Hello' },
      { from: 'you', text: 'one' },
      { from: 'you', text: 'two' },
      { from: 'aielia', text: 'list of ten' },
      { from: 'you', text: 'add the rest' },
    ])
    expect(m).toEqual([{ role: 'user', content: 'one\n\ntwo' }, { role: 'assistant', content: 'list of ten' }])
  })
  it('keeps the newest turns within the size limit and skips empty ones', () => {
    const turns = Array.from({ length: 10 }, (_, i) => [{ from: 'you' as const, text: `q${i}` }, { from: 'aielia' as const, text: `${i}`.repeat(1900) }]).flat()
    const m = chatHistoryMessages([...turns, { from: 'you', text: '   ' }])
    expect(m.reduce((n, x) => n + x.content.length, 0)).toBeLessThanOrEqual(8000)
    expect(m[0].role).toBe('user')
    expect(m[m.length - 1].content.startsWith('9')).toBe(true)
    expect(chatHistoryMessages(undefined)).toEqual([])
  })
})

describe('a change call is given the conversation', () => {
  it('puts it between the instructions and the article request', async () => {
    let seen: ChatMessage[] = []
    const llm = { callChatStructured: async (m: ChatMessage[]) => { seen = m; return { content: '{"suggestions":[]}' } } } as unknown as ILLMClient
    const meta = createArticleMeta('a', 'T')
    await suggestEdits({ meta, markdown: '# T\n\nText.\n', instruction: 'add the rest', now: '2026-10-29T10:00:00.000Z', history: [{ from: 'you', text: 'ideas?' }, { from: 'aielia', text: '1. a 2. b' }] }, llm)
    expect(seen.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(seen[2].content).toBe('1. a 2. b')
    expect(seen[3].content).toContain('add the rest')
  })
})
