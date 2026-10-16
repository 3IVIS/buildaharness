import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { acceptSuggestion, proposeSuggestion } from './article-suggestions.js'
import { suggestEdits } from './article-edit-suggest.js'
import { ArticleService, createArticleChatPort, createMemoryArticleStore } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'
import { addIdea, editIdea, removeIdea, setIdeaState, suggestIdeas } from './article-ideas.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Conclusion\n\nDone.\n'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const meta = (): ArticleMeta => ({ ...createArticleMeta('a1', 'Post'), sections: reconcileSections([], MD, ids).sections })
function client(reply: unknown | Error, seen: { users: string[] } = { users: [] }): ILLMClient {
  return { callChatStructured: async (m: { role: string; content: string }[]) => { seen.users.push(m.find((x) => x.role === 'user')!.content); if (reply instanceof Error) throw reply; return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } } } as unknown as ILLMClient
}

describe('ideas', () => {
  it('adds ideas with their origin and model, refusing empty text, unknown sections and a repeat', () => {
    const a = addIdea(meta(), { text: ' Mention the 18 ms re-run ', origin: 'writer' }, NOW)
    expect(a.ok && a.idea).toMatchObject({ id: 'id1', text: 'Mention the 18 ms re-run', origin: 'writer', state: 'open' })
    if (!a.ok) return
    const b = addIdea(a.meta, { text: 'Explain the cost', origin: 'assistant', model: 'writer-big', sectionId: 's2' }, NOW)
    expect(b.ok && b.idea).toMatchObject({ origin: 'assistant', model: 'writer-big', sectionId: 's2' })
    expect(addIdea(a.meta, { text: '  ', origin: 'writer' }, NOW)).toMatchObject({ ok: false })
    expect(addIdea(a.meta, { text: 'x', origin: 'writer', sectionId: 'nope' }, NOW)).toMatchObject({ ok: false })
    expect(addIdea(a.meta, { text: 'Mention the 18 ms re-run', origin: 'writer' }, NOW)).toMatchObject({ ok: false })
  })
  it('edits, sets aside, reopens and removes ideas', () => {
    let m = addIdea(meta(), { text: 'one', origin: 'writer' }, NOW)
    if (!m.ok) throw new Error('setup')
    const e = editIdea(m.meta, 'id1', { text: 'one, reworded', sectionId: 's2' })
    expect(e.ok && e.idea).toMatchObject({ text: 'one, reworded', sectionId: 's2' })
    if (!e.ok) return
    expect(editIdea(e.meta, 'id1', { sectionId: null }).ok && (editIdea(e.meta, 'id1', { sectionId: null }) as { idea: { sectionId?: string } }).idea.sectionId).toBeUndefined()
    const d = setIdeaState(e.meta, 'id1', 'dropped')
    expect(d.ok && d.idea.state).toBe('dropped')
    expect(setIdeaState(e.meta, 'nope', 'used')).toMatchObject({ ok: false })
    expect(removeIdea(e.meta, 'id1').ideas).toEqual([])
  })
})

describe('suggestIdeas', () => {
  it('adds the assistant\'s proposals as open ideas marked with the model, and keeps only real sections', async () => {
    const reply = { ideas: [{ text: 'Say why 18 ms matters to users', sectionId: 's2' }, { text: 'Add the memory figure', sectionId: 'nope' }, { text: '   ' }] }
    const r = await suggestIdeas({ meta: meta(), markdown: MD, now: NOW, modelName: 'writer-big' }, client(reply))
    expect(r.added.map((i) => [i.text, i.sectionId, i.model, i.origin])).toEqual([['Say why 18 ms matters to users', 's2', 'writer-big', 'assistant'], ['Add the memory figure', undefined, 'writer-big', 'assistant']])
  })
  it('shows the model the article, the sources as untrusted data and the ideas already collected; fails closed', async () => {
    const m = { ...meta(), sources: [{ id: 'src1', kind: 'upload' as const, address: 'bench.txt', passage: 'p99: 18 ms', trust: 'normal' as const, freshness: 'current' as const }] }
    const withIdea = addIdea(m, { text: 'already here', origin: 'writer' }, NOW)
    if (!withIdea.ok) throw new Error('setup')
    const seen = { users: [] as string[] }
    await suggestIdeas({ meta: withIdea.meta, markdown: MD, request: 'angles on cost', now: NOW }, client({ ideas: [] }, seen))
    const sent = JSON.parse(seen.users[0])
    expect(sent.sources[0].passage).toContain('<untrusted_external_content>')
    expect(sent.ideas).toEqual(['already here'])
    expect(sent.request).toBe('angles on cost')
    for (const c of [client(new Error('503')), client('junk'), client({ nope: 1 })]) expect((await suggestIdeas({ meta: meta(), markdown: MD, now: NOW }, c)).status).toBe('failed')
  })
})

describe('writing ideas into the article', () => {
  it('a suggestion that carries ideas marks them used, in the section they landed in, only when accepted', async () => {
    const m0 = addIdea(meta(), { text: 'Explain why 18 ms is fine', origin: 'writer' }, NOW)
    if (!m0.ok) throw new Error('setup')
    const p = proposeSuggestion(m0.meta, MD, { quote: 'The p99 was 18 ms.', replacement: 'The p99 was 18 ms, which users cannot notice.', reason: 'idea', by: 'assistant', now: NOW, ideaIds: ['id1'] })
    if (!p.ok) throw new Error('setup')
    expect(p.meta.ideas[0].state).toBe('open')
    const a = acceptSuggestion(p.meta, MD, 'sg1')
    expect(a.ok && a.meta.ideas[0]).toMatchObject({ state: 'used', usedIn: 's2' })
  })
  it('suggestEdits sends the chosen ideas to the model and keeps only the idea ids it was given', async () => {
    const m0 = addIdea(addIdea(meta(), { text: 'first', origin: 'writer' }, NOW).ok ? (addIdea(meta(), { text: 'first', origin: 'writer' }, NOW) as { meta: ArticleMeta }).meta : meta(), { text: 'second', origin: 'writer' }, NOW)
    if (!m0.ok) throw new Error('setup')
    const seen = { users: [] as string[] }
    const reply = { suggestions: [{ quote: 'Done.', replacement: 'Done. First.', reason: 'r', ideaIds: ['id1', 'id2', 'ghost'] }] }
    const r = await suggestEdits({ meta: m0.meta, markdown: MD, instruction: 'write them in', now: NOW, ideaIds: ['id1'] }, client(reply, seen))
    expect(JSON.parse(seen.users[0]).ideas).toEqual([{ id: 'id1', text: 'first' }])
    expect(r.meta.suggestions[0].ideaIds).toEqual(['id1'])
  })
})

describe('ideas through the service', () => {
  it('collects ideas, suggests more with a chosen model, writes them in via a suggestion and shows open ones to the chat', async () => {
    const store = createMemoryArticleStore()
    const used: (string | undefined)[] = []
    const llm = {
      callChatStructured: async (m: { role: string; content: string }[], _t: unknown, o?: { model?: string }) => {
        used.push(o?.model)
        const sys = m.find((x) => x.role === 'system')!.content
        if (sys.includes('collect ideas')) return { content: JSON.stringify({ ideas: [{ text: 'Say what 18 ms means for users', sectionId: 's2' }] }) }
        if (sys.includes('You propose edits')) return { content: JSON.stringify({ suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 18 ms, which users cannot notice.', reason: 'idea', ideaIds: ['id2'] }] }) }
        return { content: JSON.stringify({ articleId: null, ops: [] }) }
      },
    } as unknown as ILLMClient
    const s = new ArticleService({ store, llm, now: () => NOW, newId: () => 'a1' })
    const id = await s.create('Post', MD)
    expect(await s.addIdea(id, { text: 'Mention the re-run' })).toMatchObject({ ok: true })
    const sug = await s.suggestIdeas(id, 'angles', 'chosen-model')
    expect(sug.added[0]).toMatchObject({ origin: 'assistant', model: 'chosen-model', sectionId: 's2' })
    expect(used[0]).toBe('chosen-model')
    const port = createArticleChatPort(store)
    await port.setActive(id)
    const block = await processWriterMessage({ message: 'what next?', port, now: NOW }, llm)
    expect(block).toContain('Mention the re-run')
    expect(block).toContain('Say what 18 ms means for users')
    const written = await s.writeIdeasIn(id, ['id2'], undefined, 'writer-model')
    expect(written.added).toHaveLength(1)
    expect(used.at(-1)).toBe('writer-model')
    expect((await s.get(id)).meta.ideas.find((i) => i.id === 'id2')!.state).toBe('open')
    await s.acceptSuggestionAndUpdate(id, 'sg1', undefined, { analyze: false })
    expect((await s.get(id)).meta.ideas.find((i) => i.id === 'id2')!.state).toBe('used')
    expect((await processWriterMessage({ message: 'again', port, now: NOW }, llm))).not.toContain('Say what 18 ms means for users')
    await s.updateIdea(id, 'id1', { state: 'dropped' })
    await s.deleteIdea(id, 'id1')
    expect((await s.get(id)).meta.ideas.map((i) => i.id)).toEqual(['id2'])
  })
})
