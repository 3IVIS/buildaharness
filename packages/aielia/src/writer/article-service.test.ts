import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createArticleChatPort, createMemoryArticleStore } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'
import { proposeSuggestion } from './article-suggestions.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\nIntro: p99 under 20 ms.\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'
const MARK = { claims: 'You read parts of an article and list the claims', resolve: 'You help a writer keep an article consistent', support: 'You check whether a claim from an article', capture: 'A writer is working with an assistant' }

type Router = Partial<Record<keyof typeof MARK, unknown | ((user: string) => unknown)>>
function routed(r: Router, calls: string[] = []): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')!.content
      const user = messages.find((m) => m.role === 'user')!.content
      const key = (Object.keys(MARK) as (keyof typeof MARK)[]).find((k) => sys.includes(MARK[k]))
      calls.push(key ?? 'unknown')
      const v = key ? r[key] : undefined
      const out = typeof v === 'function' ? (v as (u: string) => unknown)(user) : v
      if (out === undefined) throw new Error(`no scripted reply for ${key}`)
      return { content: typeof out === 'string' ? out : JSON.stringify(out) }
    },
  } as unknown as ILLMClient
}
const svc = (r: Router = {}, calls: string[] = []) => {
  const store = createMemoryArticleStore()
  let n = 0
  return { store, svc: new ArticleService({ store, llm: routed(r, calls), now: () => NOW, newId: () => `art${++n}`, modelName: 'checker-1' }) }
}

describe('ArticleService', () => {
  it('creates an article with sections and lists it', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', MD)
    expect((await s.list())).toEqual([{ id, title: 'Post', name: 'Post' }])
    expect((await s.get(id)).meta.sections.map((x) => x.heading)).toEqual(['Post', 'Latency', 'Conclusion'])
  })

  it('takes the article\'s title from its first top-level heading, so editing the heading renames the article', async () => {
    const { svc: s } = svc()
    const id = await s.create('Working title', MD)
    await s.updateText(id, MD.replace('# Post', '# A better title'), { analyze: false })
    expect((await s.get(id)).meta.title).toBe('A better title')
    expect(await s.list()).toEqual([{ id, title: 'A better title', name: 'Working title' }])
    await s.updateText(id, 'No heading at all.\n', { analyze: false })
    expect((await s.get(id)).meta.title).toBe('A better title') // nothing to take it from: keeps the last one
  })

  it('updates the structure without any model call when analysis is off, and marks suggestions stale', async () => {
    const calls: string[] = []
    const { store, svc: s } = svc({}, calls)
    const id = await s.create('Post', MD)
    const b = await s.get(id)
    const p = proposeSuggestion(b.meta, b.markdown, { quote: '18 ms', replacement: '41 ms', reason: 'x', by: 'assistant', now: NOW })
    if (!p.ok) throw new Error('setup')
    await store.save(id, { ...b, meta: p.meta })
    const out = await s.updateText(id, MD.replace('18 ms', '20 ms'), { analyze: false })
    expect(calls).toEqual([])
    expect(out.changedSectionIds).toHaveLength(1)
    expect(out.bundle.meta.suggestions[0].state).toBe('stale')
    expect((await s.get(id)).markdown).toContain('20 ms')
  })

  it('after an edit: extracts claims, runs the automatic check only where a source is attached, flags other sections', async () => {
    const calls: string[] = []
    const edited = MD.replace('The p99 was 18 ms.', 'The p99 was 41 ms.')
    const { svc: s } = svc(
      {
        claims: { claims: [{ quote: 'The p99 was 41 ms.', kind: 'factual', matchesId: null, sure: true }] },
        resolve: (u: string) => ({ affected: [{ sectionId: 's1', reason: 'still says under 20 ms' }, { sectionId: 's3', reason: 'repeats under 20 ms' }] }),
      },
      calls,
    )
    const id = await s.create('Post', MD)
    const out = await s.updateText(id, edited)
    expect(out.extraction?.added).toHaveLength(1)
    expect(out.autoChecks).toEqual([{ claimId: 'k1', status: 'no_sources' }])
    expect(out.resolution?.flagged.map((f) => f.sectionId).sort()).toEqual(['s1', 's3'])
    expect(out.bundle.meta.sections.filter((x) => x.review.state === 'needs_review')).toHaveLength(2)
    expect(calls).toEqual(['claims', 'resolve'])
    expect(JSON.stringify(calls)).not.toContain('support')
  })

  it('a model step that fails is reported and leaves its part alone, but the text is still saved', async () => {
    const { svc: s } = svc({})
    const id = await s.create('Post', MD)
    const out = await s.updateText(id, MD + '\nMore.\n')
    expect(out.extraction?.status).toBe('not_extracted')
    expect(out.resolution?.status).toBe('not_resolved')
    expect((await s.get(id)).markdown).toContain('More.')
  })

  it('attaches a source by a hand-drawn link, checks the claim, and a later wording change resets the verdict', async () => {
    const calls: string[] = []
    const { svc: s } = svc({
      claims: (u: string) => ({ claims: [{ quote: JSON.parse(u).sections.map((x: { text: string }) => x.text).join('').includes('41') ? 'The p99 was 41 ms.' : 'The p99 was 18 ms.', kind: 'factual', matchesId: JSON.parse(u).known[0]?.id ?? null, sure: true }] }),
      resolve: { affected: [] },
      support: { verdict: 'supported', reason: 'matches' },
    }, calls)
    const id = await s.create('Post', MD)
    await s.analyze(id) // the first pass over a new article
    const claimId = (await s.get(id)).meta.claims[0].id
    const src = await s.addSource(id, { kind: 'upload', address: 'bench.txt', passage: 'p99 latency: 18 ms' })
    await s.attachSource(id, claimId, src)
    await s.attachSource(id, claimId, src) // idempotent
    let b = await s.get(id)
    expect(b.meta.links.filter((l) => l.kind === 'supported_by')).toEqual([expect.objectContaining({ origin: 'drawn' })])
    expect(b.meta.claims[0].sourceStatus).toBe('attached')
    const check = await s.checkClaim(id, claimId)
    expect(check.status).toBe('checked')
    b = await s.get(id)
    expect(b.meta.claims[0]).toMatchObject({ sourceStatus: 'supported', check: { model: 'checker-1' } })
    await s.updateText(id, MD.replace('18 ms.', '41 ms.'))
    b = await s.get(id)
    expect(b.meta.claims[0].quote).toBe('The p99 was 41 ms.')
    // the old verdict was dropped when the wording changed, and the new one was earned against the new text
    expect(b.meta.claims[0].check?.claimText).toBe('The p99 was 41 ms.')
    expect(calls.filter((c) => c === 'support')).toHaveLength(2)
  })

  it('rejects attaching an unknown claim or source', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', MD)
    await expect(s.attachSource(id, 'nope', 'src1')).rejects.toThrow('No claim')
    await expect(s.confirmClaim(id, 'nope')).rejects.toThrow('No claim')
  })

  it('publishes a frozen snapshot even with open items, recording the counts (warn only)', async () => {
    const { store, svc: s } = svc()
    const id = await s.create('Post', MD)
    const b = await s.get(id)
    await store.save(id, { ...b, meta: { ...b.meta, comments: [{ id: 'wc1', articleId: id, text: 'open one', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }] } })
    const out = await s.publish(id, 'v1')
    expect(out.meta.status).toBe('published')
    expect(out.snapshots).toHaveLength(1)
    expect(out.snapshots[0]).toMatchObject({ kind: 'published', label: 'v1', readiness: { openComments: 1 } })
    expect(Object.isFrozen(out.snapshots[0])).toBe(true)
  })

  it('exports and imports an article, refusing duplicates and damaged folders', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', MD)
    await s.addSource(id, { kind: 'upload', passage: 'a passage' })
    const folder = await s.exportArticle(id)
    const other = svc().svc
    expect(await other.importArticle(folder)).toEqual({ ok: true, id })
    expect((await other.get(id)).meta.sources[0].passage).toBe('a passage')
    expect(await other.importArticle(folder)).toMatchObject({ ok: false })
    expect(await svc().svc.importArticle({ 'article.md': 'x' })).toMatchObject({ ok: false })
  })
})

describe('chat-held state stored inside the articles', () => {
  it('keeps comments in each article\'s own metadata, so they travel with an export and stay apart', async () => {
    const { store, svc: s } = svc()
    const bakery = await s.create('Bakery', '# Bakery\n')
    const garden = await s.create('Garden', '# Garden\n')
    const port = createArticleChatPort(store)
    const reply = (articleId: string, label: string) => ({ capture: { articleId, ops: [{ op: 'add_comment', label, text: `${label} text` }] } })
    await processWriterMessage({ message: 'm1', port, now: NOW }, routed(reply(bakery, 'C1')))
    await processWriterMessage({ message: 'm2', port, now: NOW }, routed(reply(garden, 'G1')))
    expect((await s.get(bakery)).meta.comments.map((c) => c.label)).toEqual(['C1'])
    expect((await s.get(garden)).meta.comments.map((c) => c.label)).toEqual(['G1'])
    expect(JSON.parse((await s.exportArticle(bakery))['article.meta.json']).comments).toHaveLength(1)
    // a later message that adds nothing still gets the active article's items
    const block = await processWriterMessage({ message: 'show', port, now: NOW }, routed({ capture: { articleId: null, ops: [] } }))
    expect(block).toContain('G1')
    expect(block).not.toContain('C1')
  })
})

describe('version history', () => {
  const build = () => {
    const store = createMemoryArticleStore()
    let t = 0
    return { store, s: new ArticleService({ store, llm: routed({}), now: () => `2026-10-16T10:00:0${t++}.000Z`, newId: () => 'a1' }) }
  }
  it('lists saved versions newest first and compares one with the article now', async () => {
    const { s } = build()
    const id = await s.create('Post', MD)
    await s.saveVersion(id, 'First draft')
    await s.updateText(id, MD.replace('18 ms', '41 ms'), { analyze: false })
    await s.publish(id, 'v1')
    const h = await s.history(id)
    expect(h.map((x) => [x.kind, x.label])).toEqual([['published', 'v1'], ['checkpoint', 'First draft']])
    expect(h[0].change).toMatchObject({ first: false, added: 1, removed: 1, sections: ['Latency'] })
    expect(h[1].change.first).toBe(true)
    const diff = await s.compareWithCurrent(id, h[0].index)
    expect(diff.changedLines).toBe(0)
    const older = await s.compareWithCurrent(id, h[1].index)
    expect(older.text.some((l) => l.type === 'add' && l.text.includes('41 ms'))).toBe(true)
    await expect(s.compareWithCurrent(id, 9)).rejects.toThrow('No version')
    await s.updateText(id, MD.replace('18 ms', '41 ms') + '\nA new last line.\n', { analyze: false })
    expect(await s.changeSinceLastVersion(id)).toMatchObject({ added: 2 })
    const fresh = build()
    expect(await fresh.s.changeSinceLastVersion(await fresh.s.create('Empty', '# E\n'))).toBeUndefined()
  })
  it('keeps a checkpoint before a suggestion is accepted and before a large rewrite', async () => {
    const { s } = build()
    const id = await s.create('Post', MD)
    const b = await s.get(id)
    const p = proposeSuggestion(b.meta, b.markdown, { quote: '18 ms', replacement: '41 ms', reason: 'r', by: 'assistant', now: NOW })
    if (!p.ok) throw new Error('setup')
    await s['store'].save(id, { ...b, meta: p.meta })
    await s.acceptSuggestionAndUpdate(id, 'sg1', undefined, { analyze: false })
    expect((await s.history(id))[0]).toMatchObject({ kind: 'checkpoint', label: 'Before accepting a suggested change' })
    const rewrite = Array.from({ length: 12 }, (_, i) => `# Heading ${i}\n\nNew text ${i}.`).join('\n\n')
    await s.updateText(id, rewrite, { analyze: false })
    expect((await s.history(id))[0].label).toBe('Before a large change')
  })
  it('restores an old version as the working article after saving the present one, and keeps comments', async () => {
    const { store, s } = build()
    const id = await s.create('Post', MD)
    await s.saveVersion(id, 'Original')
    await s.updateText(id, MD.replace('18 ms', '41 ms'), { analyze: false })
    const b = await s.get(id)
    await store.save(id, { ...b, meta: { ...b.meta, comments: [{ id: 'wc1', articleId: id, text: 'keep me', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }] } })
    const restored = await s.restore(id, 0)
    expect(restored.markdown).toBe(MD)
    expect(restored.meta.comments).toHaveLength(1)
    expect(restored.meta.status).toBe('drafting')
    const h = await s.history(id)
    expect(h[0].label).toBe('Before restoring an earlier version')
    expect((await s.getVersion(id, h[0].index)).markdown).toContain('41 ms')
    expect(h.some((x) => x.label === 'Original')).toBe(true)
  })
})


describe('dependencies through the service', () => {
  it('finds proposals, lets only the writer confirm or remove, and refuses a circle', async () => {
    const store = createMemoryArticleStore()
    const reply = { links: [{ from: 's3', to: 's2', kind: 'repeats', reason: 'repeats the bound', confidence: 0.8 }] }
    const s = new ArticleService({ store, llm: routedLinks(reply), now: () => NOW, newId: () => 'a1' })
    const id = await s.create('Post', MD)
    const found = await s.findDependencies(id)
    expect(found.added).toHaveLength(1)
    const linkId = found.added[0].id
    expect((await s.get(id)).meta.links[0]).toMatchObject({ origin: 'proposed' })
    expect(await s.confirmDependency(id, linkId)).toEqual({ ok: true })
    expect((await s.get(id)).meta.links[0].origin).toBe('confirmed')
    expect(await s.addDependency(id, 's2', 's3', 'rests_on')).toEqual({ ok: true })
    expect(await s.addDependency(id, 's3', 's2', 'rests_on')).toMatchObject({ ok: false })
    expect(await s.removeDependency(id, linkId)).toEqual({ ok: true })
    expect((await s.get(id)).meta.links).toHaveLength(1)
  })
})

function routedLinks(reply: unknown): ILLMClient {
  return { callChatStructured: async () => ({ content: JSON.stringify(reply) }) } as unknown as ILLMClient
}

describe('a model for each role', () => {
  it('uses the writer model for edit suggestions and the checker model for everything that checks, and records who proposed what', async () => {
    const used: { role: string; model?: string }[] = []
    const llm = {
      callChatStructured: async (messages: { role: string; content: string }[], _t: unknown, o?: { model?: string }) => {
        const sys = messages.find((m) => m.role === 'system')!.content
        const role = sys.includes('You propose edits') ? 'edits' : sys.includes('You read parts of an article') ? 'claims' : sys.includes('You map how the sections') ? 'links' : sys.includes('You check whether a claim') ? 'support' : 'other'
        used.push({ role, model: o?.model })
        if (role === 'edits') return { content: JSON.stringify({ suggestions: [{ quote: '18 ms', replacement: '41 ms', reason: 'r' }] }) }
        if (role === 'claims') return { content: JSON.stringify({ claims: [] }) }
        return { content: JSON.stringify({ links: [] }) }
      },
    } as unknown as ILLMClient
    let writer = 'writer-big'
    const s = new ArticleService({ store: createMemoryArticleStore(), llm, now: () => NOW, newId: () => 'a1', modelFor: (role) => (role === 'writer' ? writer : 'checker-small') })
    const id = await s.create('Post', MD)
    const r = await s.suggest(id, 'update the figure')
    expect(r.meta.suggestions[0].model).toBe('writer-big')
    await s.analyze(id)
    await s.findDependencies(id)
    expect(used.filter((u) => u.role === 'edits').map((u) => u.model)).toEqual(['writer-big'])
    expect(used.filter((u) => u.role !== 'edits').every((u) => u.model === 'checker-small')).toBe(true)
    writer = 'writer-other' // changed between calls: the next call uses it
    await s.suggest(id, 'again')
    expect(used.filter((u) => u.role === 'edits').map((u) => u.model)).toEqual(['writer-big', 'writer-other'])
  })
})

describe('article name', () => {
  it('starts as what the writer called the article, can be renamed, and does not follow the heading in the text', async () => {
    const { svc: s } = svc()
    const id = await s.create('Dashboard post', MD)
    expect(await s.list()).toEqual([{ id, title: 'Post', name: 'Dashboard post' }]) // the title is the heading; the name is what it was filed as
    await s.rename(id, '  Q3 write-up ')
    await s.updateText(id, MD.replace('# Post', '# A completely different heading'), { analyze: false })
    expect((await s.list())[0]).toEqual({ id, title: 'A completely different heading', name: 'Q3 write-up' })
    await expect(s.rename(id, '   ')).rejects.toThrow('empty')
  })
})

describe('sources for the text under the cursor, through the service', () => {
  const build = (reply: unknown = {}) => {
    const store = createMemoryArticleStore()
    return { store, s: new ArticleService({ store, llm: routedLinks(reply), now: () => NOW, newId: () => 'a1' }) }
  }
  it('attaches a stored source to the sentence at the cursor and detaches it again', async () => {
    const { s } = build()
    const id = await s.create('Post', MD)
    const src = await s.addSource(id, { kind: 'upload', address: 'bench.txt', passage: 'p99: 18 ms' })
    const at = MD.indexOf('18 ms')
    const r = await s.attachSourceToText(id, { start: at, end: at }, src)
    expect(r).toMatchObject({ ok: true, createdClaim: true })
    let b = await s.get(id)
    expect(b.meta.claims[0]).toMatchObject({ quote: 'The p99 was 18 ms.', author: 'writer', sourceStatus: 'attached' })
    expect(await s.detachSource(id, b.meta.claims[0].id, src)).toEqual({ ok: true })
    b = await s.get(id)
    expect(b.meta.links).toHaveLength(0)
    expect(b.meta.claims[0].sourceStatus).toBe('none')
    expect(await s.detachSource(id, 'k1', src)).toMatchObject({ ok: false })
  })
  it('proposes which claims a dropped source bears on', async () => {
    const { s } = build({ claims: [{ claimId: 'k1', relation: 'supports', reason: 'same figure', confidence: 0.9 }] })
    const id = await s.create('Post', MD)
    const a = MD.indexOf('18 ms')
    const first = await s.addSource(id, { kind: 'upload', passage: 'x' })
    await s.attachSourceToText(id, { start: a, end: a }, first) // creates claim k1
    const dropped = await s.addSource(id, { kind: 'upload', address: 'notes.txt', passage: 'p99 is 18 ms' })
    const r = await s.proposeLinksForSource(id, dropped)
    expect(r.added).toHaveLength(1)
    expect((await s.get(id)).meta.links.some((l) => l.origin === 'proposed' && l.to.id === dropped)).toBe(true)
  })
  it('lets a call name its own model, over the defaults', async () => {
    const used: (string | undefined)[] = []
    const llm = { callChatStructured: async (_m: unknown, _t: unknown, o?: { model?: string }) => { used.push(o?.model); return { content: JSON.stringify({ claims: [], links: [], suggestions: [] }) } } } as unknown as ILLMClient
    const s = new ArticleService({ store: createMemoryArticleStore(), llm, now: () => NOW, newId: () => 'a1', modelFor: () => 'default-model' })
    const id = await s.create('Post', MD)
    await s.analyze(id, 'chosen-for-this-check')
    await s.findDependencies(id, 'chosen-too')
    await s.suggest(id, 'x', 'chosen-writer')
    await s.analyze(id)
    expect(used).toEqual(['chosen-for-this-check', 'chosen-too', 'chosen-writer', 'default-model'])
  })
})
