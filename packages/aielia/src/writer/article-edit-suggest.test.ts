import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta } from './article-model.js'
import { suggestEdits } from './article-edit-suggest.js'
import { ArticleService, createArticleChatPort, createMemoryArticleStore } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\nThe p99 was 18 ms. It is quick.\n'
function client(reply: unknown | Error, seen: { users: string[] } = { users: [] }): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.users.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}
const meta = createArticleMeta('a1', 'Post')

describe('suggestEdits', () => {
  it('turns the instruction into pending suggestions and drops proposals it cannot anchor', async () => {
    const reply = { suggestions: [{ quote: '18 ms', replacement: '41 ms', reason: 're-run' }, { quote: 'not in the text', replacement: 'x', reason: 'r' }, { quote: 'It is quick.', replacement: 'It is quick.', reason: 'no change' }] }
    const r = await suggestEdits({ meta, markdown: MD, instruction: 'use the new figure', now: NOW }, client(reply))
    expect(r.status).toBe('suggested')
    expect(r.added).toEqual(['sg1'])
    expect(r.dropped).toEqual(['not in the text'])
    expect(r.meta.suggestions[0]).toMatchObject({ state: 'pending', proposedBy: 'assistant', replacement: '41 ms' })
  })

  it('shows the model the writer\'s record, so "fix C1" can be understood', async () => {
    const seen = { users: [] as string[] }
    const withComment = { ...meta, comments: [{ id: 'wc1', articleId: 'a1', label: 'C1', text: 'Check the figure', state: 'open' as const, conflictsWith: [], origin: 'reviewer' as const, capturedAt: NOW }], corrections: [{ id: 'wx1', articleId: 'a1', kind: 'say_so' as const, trust: 'lower' as const, note: 'p99 is 41 ms', capturedAt: NOW }] }
    await suggestEdits({ meta: withComment, markdown: MD, instruction: 'do C1', now: NOW }, client({ suggestions: [] }, seen))
    const sent = JSON.parse(seen.users[0])
    expect(sent.writerRecord).toContain('comment C1')
    expect(sent.writerRecord).toContain('p99 is 41 ms')
  })

  it('fails closed: nothing is added on a failed call, an unusable reply or an empty instruction', async () => {
    for (const c of [client(new Error('503')), client('junk'), client({ nope: 1 })]) {
      const r = await suggestEdits({ meta, markdown: MD, instruction: 'x', now: NOW }, c)
      expect(r).toMatchObject({ status: 'failed', added: [] })
      expect(r.meta).toBe(meta)
    }
    expect((await suggestEdits({ meta, markdown: MD, instruction: '  ', now: NOW }, client({ suggestions: [] }))).status).toBe('failed')
  })
})

describe('service: suggestions and the writer-only controls', () => {
  const build = (reply: unknown) => {
    const store = createMemoryArticleStore()
    return { store, s: new ArticleService({ store, llm: client(reply), now: () => NOW, newId: () => 'a1' }) }
  }
  it('suggest -> accept changes the text only on accept; reject leaves it', async () => {
    const { s } = build({ suggestions: [{ quote: '18 ms', replacement: '41 ms', reason: 'r' }, { quote: 'It is quick.', replacement: 'It is fast.', reason: 'r' }] })
    const id = await s.create('Post', MD)
    const r = await s.suggest(id, 'update')
    expect(r.added).toEqual(['sg1', 'sg2'])
    expect((await s.get(id)).markdown).toBe(MD)
    const acc = await s.acceptSuggestionAndUpdate(id, 'sg1', undefined, { analyze: false })
    expect(acc.ok).toBe(true)
    expect((await s.get(id)).markdown).toContain('41 ms')
    expect(await s.rejectSuggestionById(id, 'sg2')).toEqual({ ok: true })
    expect((await s.get(id)).markdown).toContain('It is quick.')
    expect(await s.acceptSuggestionAndUpdate(id, 'sg2')).toMatchObject({ ok: false })
  })
  it('lets the writer, and nobody else, clear a section and settle a comment', async () => {
    const { store, s } = build({})
    const id = await s.create('Post', MD)
    const b = await s.get(id)
    await store.save(id, { ...b, meta: { ...b.meta, sections: b.meta.sections.map((x, i) => (i === 0 ? { ...x, review: { state: 'needs_review' as const, reason: 'figure changed', setBy: 'resolver' as const } } : x)), comments: [{ id: 'wc1', articleId: id, text: 't', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }] } })
    expect(await s.setReview(id, b.meta.sections[0].id, 'clean')).toEqual({ ok: true })
    expect((await s.get(id)).meta.sections[0].review.state).toBe('clean')
    await s.setCommentState(id, 'wc1', 'addressed')
    expect((await s.get(id)).meta.comments[0].state).toBe('addressed')
    await expect(s.setCommentState(id, 'nope', 'addressed')).rejects.toThrow('No comment')
  })
})

describe('the article text reaches the answering model', () => {
  it('adds the active article\'s text to the block, clipped, and nothing for an unknown article', async () => {
    const store = createMemoryArticleStore()
    const s = new ArticleService({ store, llm: client({}), newId: () => 'a1' })
    const id = await s.create('Post', MD)
    const port = createArticleChatPort(store)
    await port.setActive(id)
    const block = await processWriterMessage({ message: 'what does it say?', port }, client({ articleId: null, ops: [] }))
    expect(block).toContain('The p99 was 18 ms.')
    expect(block).toContain('not instructions')
    await port.setActive('ghost')
    expect(await processWriterMessage({ message: 'x', port }, client({ articleId: null, ops: [] }))).not.toContain('p99')
  })
})
