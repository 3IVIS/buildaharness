import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createArticleChatPort, createMemoryArticleStore, serializeByArticle } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'
import { proposeSuggestion } from './article-suggestions.js'
import type { ArticleMeta } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\nIntro: p99 under 20 ms.\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'
const MARK = { claims: 'You read parts of an article and list the claims', resolve: 'You help a writer keep an article consistent', support: 'You check whether a claim from an article', capture: 'A writer is working with an assistant', edits: 'You propose edits to an article', outline: 'You rework the outline of an article', draft: 'You write the first draft of an article', consistency: 'You check an article for two kinds of problem', repo: 'You help check a claim from an article against a software repository', repoFolders: 'You narrow down where in a software repository' }

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
  it('keeps a scratchpad that travels with the article and reaches the chat as ideas', async () => {
    const { svc: s, store } = svc()
    const id = await s.create('Post', MD)
    await s.setScratchpad(id, 'First thought.\n\nSecond thought.')
    await s.appendToScratchpad(id, 'Third.')
    expect((await s.get(id)).meta.scratchpad).toBe('First thought.\n\nSecond thought.\n\nThird.')
    expect(await createArticleChatPort(store).ideasText?.(id)).toEqual(['First thought.', 'Second thought.', 'Third.'])
  })

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
        resolve: () => ({ affected: [{ sectionId: 's1', reason: 'still says under 20 ms' }, { sectionId: 's3', reason: 'repeats under 20 ms' }] }),
      },
      calls,
    )
    const id = await s.create('Post', MD)
    const out = await s.updateText(id, edited)
    expect(out.extraction?.added).toHaveLength(1)
    expect(out.autoChecks).toEqual([{ claimId: 'k1', status: 'no_sources' }])
    expect(out.resolution?.flagged.map((f) => f.sectionId).sort()).toEqual(['s1', 's3'])
    expect(out.bundle.meta.sections.filter((x) => x.review.state === 'needs_review')).toHaveLength(2)
    expect(calls).toEqual(['claims', 'consistency', 'resolve'])
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

  it('drops the source link of a claim that a rewording replaced, so the integrity check stays clean', async () => {
    const { svc: s } = svc({
      // the model does not match the reworded sentence to the old claim, so the old (unconfirmed) claim goes and a new one appears
      claims: (u: string) => ({ claims: [{ quote: JSON.parse(u).sections.map((x: { text: string }) => x.text).join('').includes('41') ? 'The p99 was 41 ms.' : 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }),
      resolve: { affected: [] },
      support: { verdict: 'supported', reason: 'ok' },
    })
    const id = await s.create('Post', MD)
    await s.analyze(id)
    const claimId = (await s.get(id)).meta.claims[0].id
    const src = await s.addSource(id, { kind: 'upload', address: 'bench.txt', passage: 'p99 latency: 18 ms' })
    await s.attachSource(id, claimId, src)
    await s.updateText(id, MD.replace('18 ms', '41 ms'))
    const b = await s.get(id)
    expect(b.meta.claims.map((c) => c.id)).not.toContain(claimId)
    expect(s.readiness(b).problems).toEqual([])
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
  it('autosaves the text it is given as a version, once per different text, and keeps the writer\'s own versions', async () => {
    const { s } = build()
    const id = await s.create('Post', MD)
    await s.saveVersion(id, 'Mine')
    expect(await s.autosave(id, MD)).toBe(false) // same as the latest version
    expect(await s.autosave(id, MD.replace('18 ms', '19 ms'))).toBe(true)
    expect(await s.autosave(id, MD.replace('18 ms', '19 ms'))).toBe(false)
    expect((await s.get(id)).markdown).toContain('19 ms')
    const h = await s.history(id)
    expect(h.map((x) => x.label)).toEqual(['Autosaved', 'Mine'])
  })
  it('keeps only the newest autosaved versions and does not let them push out the writer\'s own', async () => {
    const { s } = build()
    const id = await s.create('Post', MD)
    await s.saveVersion(id, 'Mine')
    for (let n = 0; n < 40; n++) await s.autosave(id, `${MD}\nLine ${n}.\n`)
    const h = await s.history(id)
    expect(h.filter((x) => x.label === 'Autosaved')).toHaveLength(30)
    expect(h.some((x) => x.label === 'Mine')).toBe(true)
  })
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
    expect(used).toEqual(['chosen-for-this-check', 'chosen-for-this-check', 'chosen-too', 'chosen-writer', 'default-model', 'default-model'])
  })
})


describe('editing in place', () => {
  it('renames a section by changing its heading in the text, keeping its identity, and refuses the opening and an empty heading', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', 'Opening line.\n\n# Post\n\n## Latency\n\nThe p99 was 18 ms.\n')
    const latency = (await s.get(id)).meta.sections.find((x) => x.heading === 'Latency')!
    expect(await s.renameSection(id, latency.id, '  Response   time ')).toEqual({ ok: true })
    const b = await s.get(id)
    expect(b.markdown).toContain('## Response time\n')
    expect(b.meta.sections.find((x) => x.id === latency.id)?.heading).toBe('Response time')
    const opening = b.meta.sections.find((x) => x.level === 0)!
    expect(await s.renameSection(id, opening.id, 'x')).toMatchObject({ ok: false })
    expect(await s.renameSection(id, latency.id, '   ')).toMatchObject({ ok: false })
    expect(await s.renameSection(id, 'nope', 'x')).toMatchObject({ ok: false })
  })
  it('sets and clears the outline purpose of a section', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', MD)
    const sec = (await s.get(id)).meta.sections[1]
    await s.setSectionPurpose(id, sec.id, '  Show the latency  ')
    expect((await s.get(id)).meta.sections[1].purpose).toBe('Show the latency')
    await s.setSectionPurpose(id, sec.id, '')
    expect((await s.get(id)).meta.sections[1].purpose).toBeUndefined()
  })
  it('comments on highlighted text, edits and deletes them, and the comment follows the text', async () => {
    const { svc: s } = svc()
    const id = await s.create('Post', MD)
    const at = MD.indexOf('18 ms')
    expect(await s.addComment(id, { start: at, end: at }, 'Is this the median?')).toEqual({ ok: true })
    expect(await s.addComment(id, { start: at, end: at }, '  ')).toMatchObject({ ok: false })
    await s.updateText(id, 'New intro.\n\n' + MD, { analyze: false })
    const c = (await s.get(id)).meta.comments[0]
    expect(c.span?.quote).toBe('The p99 was 18 ms.')
    expect(c.outdated).toBeUndefined()
    expect(await s.editComment(id, c.id, { text: 'Is this p99 or the median?', decision: 'Say p99' })).toEqual({ ok: true })
    expect((await s.get(id)).meta.comments[0]).toMatchObject({ text: 'Is this p99 or the median?', decision: 'Say p99' })
    expect(await s.editComment(id, c.id, { text: ' ' })).toMatchObject({ ok: false })
    await s.deleteComment(id, c.id)
    expect((await s.get(id)).meta.comments).toEqual([])
  })
  it('edits a correction, and a source passage edit makes checks made against the old passage stop counting', async () => {
    const { store, svc: s } = svc({ support: { verdict: 'supported', reason: 'ok' }, claims: { claims: [] } })
    const id = await s.create('Post', MD)
    const src = await s.addSource(id, { kind: 'upload', address: 'a.txt', passage: 'p99: 18 ms' })
    const at = MD.indexOf('18 ms')
    await s.attachSourceToText(id, { start: at, end: at }, src)
    const claimId = (await s.get(id)).meta.claims[0].id
    await s.checkClaim(id, claimId)
    const before = await s.get(id)
    expect(before.meta.claims[0].sourceStatus).toBe('supported')
    expect(await s.editSource(id, src, { passage: 'p99: 41 ms', address: 'b.txt' })).toEqual({ ok: true })
    const after = await s.get(id)
    expect(after.meta.sources[0]).toMatchObject({ passage: 'p99: 41 ms', address: 'b.txt' })
    expect(effectiveSourceStatus(after.meta.claims[0], after.meta.sources)).toBe('stale')
    await store.save(id, { ...after, meta: { ...after.meta, corrections: [{ id: 'wx1', articleId: id, kind: 'say_so', trust: 'lower', note: 'old', capturedAt: NOW }] } })
    expect(await s.editCorrection(id, 'wx1', { note: 'p99 is 41 ms', supersedes: '18 ms' })).toEqual({ ok: true })
    expect((await s.get(id)).meta.corrections[0]).toMatchObject({ note: 'p99 is 41 ms', supersedes: '18 ms' })
    expect(await s.editCorrection(id, 'wx1', { note: ' ' })).toMatchObject({ ok: false })
  })
  it('renames a saved version but not a published one', async () => {
    const { s } = (() => { const x = svc(); return { s: x.svc } })()
    const id = await s.create('Post', MD)
    await s.saveVersion(id, 'Draft')
    await s.publish(id, 'v1')
    const h = await s.history(id)
    expect(await s.renameVersion(id, h[1].index, 'First draft')).toEqual({ ok: true })
    expect((await s.history(id))[1].label).toBe('First draft')
    expect(await s.renameVersion(id, h[0].index, 'x')).toMatchObject({ ok: false })
  })
})

describe('resolving issues in batches', () => {
  const sg = (id: string, quote: string, replacement: string, extra: object = {}) => ({ id, span: { start: MD.indexOf(quote), end: MD.indexOf(quote) + quote.length, quote }, replacement, reason: 'r', proposedBy: 'assistant' as const, state: 'pending' as const, createdAt: NOW, ...extra })
  const setup = async (replies: Router = {}, edit?: (m: ArticleMeta) => ArticleMeta) => {
    const calls: string[] = []
    const store = createMemoryArticleStore()
    const s = new ArticleService({ store, llm: routed(replies, calls), now: () => NOW, newId: () => 'a1', modelFor: () => 'default-model' })
    const id = await s.create('Post', MD)
    if (edit) { const b = await s.get(id); await store.save(id, { ...b, meta: edit(b.meta) }) }
    return { s, id, calls, store }
  }

  it('suggestions: accepts them all in one go, from the end of the text, with one checkpoint, and says what no longer fit', async () => {
    const { s, id } = await setup({}, (m) => ({ ...m, suggestions: [sg('sg1', '18 ms', '41 ms'), sg('sg2', 'So p99 stays under 20 ms.', 'So p99 stays under 41 ms.'), sg('sg3', 'gone text', 'x', { span: { start: 3, end: 12, quote: 'gone text' } })] }))
    const r = await s.resolveCategory(id, 'suggestions')
    expect(r).toMatchObject({ category: 'suggestions', done: 2 })
    expect(r.note).toContain('1 no longer fit')
    const b = await s.get(id)
    expect(b.markdown).toContain('41 ms')
    expect(b.markdown).toContain('So p99 stays under 41 ms.')
    expect(b.snapshots.filter((x) => x.label === 'Before accepting suggested changes')).toHaveLength(1)
  })
  it('stale and links: dismisses stale suggestions and confirms every proposed link', async () => {
    const { s, id } = await setup({}, (m) => ({
      ...m,
      suggestions: [{ ...sg('sg1', '18 ms', '41 ms'), state: 'stale' as const }],
      links: [{ id: 'lk1', from: { type: 'section', id: 's3' }, to: { type: 'section', id: 's2' }, kind: 'repeats', origin: 'proposed', at: NOW }, { id: 'lk2', from: { type: 'section', id: 's3' }, to: { type: 'section', id: 's2' }, kind: 'rests_on', origin: 'drawn', at: NOW }],
    }))
    expect((await s.resolveCategory(id, 'stale')).done).toBe(1)
    expect((await s.get(id)).meta.suggestions[0].state).toBe('rejected')
    expect((await s.resolveCategory(id, 'links')).done).toBe(1)
    expect((await s.get(id)).meta.links.map((l) => l.origin)).toEqual(['confirmed', 'drawn'])
  })
  it('checkable: checks every claim that has a passage, with the model given', async () => {
    const used: (string | undefined)[] = []
    const store = createMemoryArticleStore()
    const llm = { callChatStructured: async (_m: unknown, _t: unknown, o?: { model?: string }) => { used.push(o?.model); return { content: JSON.stringify({ verdict: 'supported', reason: 'ok' }) } } } as unknown as ILLMClient
    const s = new ArticleService({ store, llm, now: () => NOW, newId: () => 'a1' })
    const id = await s.create('Post', MD)
    const src = await s.addSource(id, { kind: 'upload', passage: 'p99: 18 ms' })
    const at = MD.indexOf('18 ms')
    await s.attachSourceToText(id, { start: at, end: at }, src)
    const r = await s.resolveCategory(id, 'checkable', { model: 'chosen' })
    expect(r).toMatchObject({ done: 1 })
    expect(used).toEqual(['chosen'])
    expect((await s.get(id)).meta.claims[0].sourceStatus).toBe('supported')
  })
  it('comments: asks for edits that address the open ones, leaves comments in conflict alone, and accepting closes the comments', async () => {
    const reply = { suggestions: [{ quote: '18 ms', replacement: '18 ms (p99)', reason: 'C1', commentIds: ['wc1', 'wc2', 'ghost'] }] }
    const { s, id, calls } = await setup({ edits: reply }, (m) => ({
      ...m,
      comments: [
        { id: 'wc1', articleId: 'a1', label: 'C1', text: 'Say which percentile', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW },
        { id: 'wc2', articleId: 'a1', label: 'C4', text: 'Open with cost', state: 'open', conflictsWith: ['wc3'], origin: 'reviewer', capturedAt: NOW },
        { id: 'wc3', articleId: 'a1', label: 'C5', text: 'Cost last', state: 'open', conflictsWith: ['wc2'], origin: 'reviewer', capturedAt: NOW },
      ],
    }))
    const r = await s.resolveCategory(id, 'comments', { model: 'm1' })
    expect(r.done).toBe(1)
    expect(calls).toEqual(['edits'])
    const sug = (await s.get(id)).meta.suggestions[0]
    expect(sug.commentIds).toEqual(['wc1']) // only the comments it was given: not the conflicting one, not an unknown id
    await s.resolveCategory(id, 'suggestions')
    const after = await s.get(id)
    expect(after.meta.comments.find((c) => c.id === 'wc1')).toMatchObject({ state: 'addressed', suggestionId: sug.id })
    expect(after.meta.comments.find((c) => c.id === 'wc2')?.state).toBe('open')
  })
  it('sections: suggests edits for flagged sections, and accepting clears the flag as the writer\'s act', async () => {
    const reply = { suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 41 ms.', reason: 'figure changed', sectionIds: ['s2'] }] }
    const { s, id } = await setup({ edits: reply }, (m) => ({ ...m, sections: m.sections.map((x) => (x.id === 's2' ? { ...x, review: { state: 'needs_review' as const, reason: 'figure changed', setBy: 'resolver' as const } } : x)) }))
    expect((await s.resolveCategory(id, 'sections')).done).toBe(1)
    expect((await s.get(id)).meta.sections.find((x) => x.id === 's2')!.review.state).toBe('needs_review')
    await s.resolveCategory(id, 'suggestions')
    expect((await s.get(id)).meta.sections.find((x) => x.id === 's2')!.review).toMatchObject({ state: 'clean', setBy: 'writer' })
  })
  it('a failed model step changes nothing and says so', async () => {
    const { s, id } = await setup({}, (m) => ({ ...m, sections: m.sections.map((x) => (x.id === 's2' ? { ...x, review: { state: 'needs_review' as const, reason: 'r' } } : x)) }))
    const r = await s.resolveCategory(id, 'sections')
    expect(r).toMatchObject({ done: 0 })
    expect(r.note).toContain('Nothing was changed')
  })
  it('resolve all: runs each category once in a sensible order, prepares suggestions without applying them, and applies them only when asked', async () => {
    const reply = { suggestions: [{ quote: 'So p99 stays under 20 ms.', replacement: 'So p99 stays under 41 ms.', reason: 'r', sectionIds: ['s3'] }] }
    const { s, id, calls } = await setup({ edits: reply }, (m) => ({ ...m, sections: m.sections.map((x) => (x.id === 's3' ? { ...x, review: { state: 'needs_review' as const, reason: 'r' } } : x)) }))
    const first = await s.resolveAll(id, { model: 'm1' })
    expect(first.map((r) => r.category)).toEqual(['links', 'checkable', 'comments', 'unsupported', 'sections', 'stale'])
    expect((await s.get(id)).markdown).not.toContain('So p99 stays under 41 ms.')
    expect(calls.filter((c) => c === 'edits').length).toBeGreaterThanOrEqual(1)
    const second = await s.resolveAll(id, { model: 'm1', categories: ['stale'], accept: true })
    expect(second.map((r) => r.category)).toEqual(['stale', 'suggestions'])
    expect((await s.get(id)).markdown).toContain('So p99 stays under 41 ms.')
  })
})


describe('editing a suggestion before accepting it', () => {
  it('changes the replacement text of a pending suggestion, and the accepted text is the edited one', async () => {
    const store = createMemoryArticleStore()
    const s = new ArticleService({ store, llm: routed({}), now: () => NOW, newId: () => 'a1' })
    const id = await s.create('Post', MD)
    const b = await s.get(id)
    const p = proposeSuggestion(b.meta, b.markdown, { quote: '18 ms', replacement: '41 ms', reason: 'r', by: 'assistant', now: NOW })
    if (!p.ok) throw new Error('setup')
    await store.save(id, { ...b, meta: p.meta })
    expect(await s.editSuggestion(id, 'sg1', '41 milliseconds')).toEqual({ ok: true })
    await s.acceptSuggestionAndUpdate(id, 'sg1', undefined, { analyze: false })
    expect((await s.get(id)).markdown).toContain('41 milliseconds')
    expect(await s.editSuggestion(id, 'sg1', 'again')).toMatchObject({ ok: false })
    expect(await s.editSuggestion(id, 'nope', 'x')).toMatchObject({ ok: false })
  })
})

describe('serializeByArticle', () => {
  it('keeps both results when two source-link proposals start together (the plain service loses one), and reads do not wait', async () => {
    const claim = { id: 'k1', sectionId: 's1', quote: 'The p99 was 18 ms.', position: 0, kind: 'factual' as const, author: 'model' as const, authorAt: NOW, confirmed: false, sourceStatus: 'none' as const }
    const reply = { claims: [{ claimId: 'k1', relation: 'supports', reason: 'same figure', confidence: 0.9 }] }
    const build = async (wrap: boolean) => {
      const store = createMemoryArticleStore()
      const llm = { callChatStructured: async () => { await new Promise((r) => setTimeout(r, 20)); return { content: JSON.stringify(reply) } } } as unknown as ILLMClient
      const raw = new ArticleService({ store, llm, now: () => NOW, newId: () => 'art1' })
      const s = wrap ? serializeByArticle(raw) : raw
      const id = await s.create('Post', MD)
      const b = await s.get(id)
      await store.save(id, { ...b, meta: { ...b.meta, claims: [{ ...claim, sectionId: b.meta.sections[0].id }] } })
      const a = await s.addSource(id, { kind: 'upload', address: 'a.txt', passage: 'p99 18 ms' })
      const c = await s.addSource(id, { kind: 'upload', address: 'c.txt', passage: 'p99 is 18 ms too' })
      await Promise.all([s.proposeLinksForSource(id, a), s.proposeLinksForSource(id, c)])
      return (await s.get(id)).meta.links.filter((l) => l.kind === 'supported_by').map((l) => l.to.id).sort()
    }
    expect(await build(false)).toHaveLength(1) // the lost update this wrapper exists for
    expect(await build(true)).toEqual(expect.arrayContaining([expect.any(String)]))
    expect((await build(true))).toHaveLength(2)
  })
})

describe('the chat edits the article itself', () => {
  it('saves a version first, then applies only the changes of this request, and the text is the edited one', async () => {
    const { svc: s } = svc({ edits: { suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 12 ms.', reason: 'new figure' }] } })
    const id = await s.create('Post', MD)
    const r = await s.editFromChat(id, 'Use the new p99 figure of 12 ms')
    expect(r.status).toBe('applied')
    expect(r.applied).toEqual([{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 12 ms.' }])
    const b = await s.get(id)
    expect(b.markdown).toContain('The p99 was 12 ms.')
    const saved = b.snapshots.find((x) => x.label === r.savedAs)
    expect(saved?.markdown).toBe(MD) // the text as it was before the edit
    expect(r.savedAs).toMatch(/^Before a chat edit: Use the new p99/)
  })
  it('saves a version even when nothing changes, and leaves other waiting suggestions alone', async () => {
    const { svc: s } = svc({ edits: { suggestions: [] } })
    const id = await s.create('Post', MD)
    const r = await s.editFromChat(id, 'Tighten the intro')
    expect(r.status).toBe('nothing')
    expect((await s.get(id)).snapshots.some((x) => x.label === r.savedAs)).toBe(true)
    expect((await s.get(id)).markdown).toBe(MD)
  })
  it('a failed edit still leaves the saved version and the text as it was', async () => {
    const { svc: s } = svc({})
    const id = await s.create('Post', MD)
    const r = await s.editFromChat(id, 'Tighten the intro')
    expect(r.status).toBe('failed')
    expect((await s.get(id)).markdown).toBe(MD)
  })
  it('an article with no text is drafted from the instruction, after a saved version', async () => {
    const { svc: s } = svc({ draft: { markdown: '# Post\n## Intro\nIt is quick.' } })
    const id = await s.create('Post', '')
    const r = await s.draftFromChat(id, 'Write it from my notes')
    expect(r.status).toBe('drafted')
    const b = await s.get(id)
    expect(b.markdown).toBe('# Post\n## Intro\nIt is quick.\n')
    expect(b.snapshots.some((x) => x.label === r.savedAs)).toBe(true)
  })
  it('the draft, the edit suggestions and the chat all get the text of the stored sources', async () => {
    const seen: string[] = []
    const { svc: s, store } = svc({ draft: (u: string) => { seen.push(u); return { name: 'N', markdown: '# N\n' } }, edits: (u: string) => { seen.push(u); return { suggestions: [] } } })
    const id = await s.create('Post', MD)
    await s.addSource(id, { kind: 'upload', address: 'brief.pdf', passage: 'The brief says latency matters most.' })
    await s.draftFromChat(id, 'Write it')
    await s.suggest(id, 'Tighten')
    expect(seen).toHaveLength(2)
    for (const u of seen) expect(u).toContain('The brief says latency matters most.')
    expect(await createArticleChatPort(store).sourcesText?.(id)).toContain('brief.pdf')
  })
  it('a draft that fails leaves the text as it was', async () => {
    const { svc: s } = svc({})
    const id = await s.create('Post', '')
    expect((await s.draftFromChat(id, 'Write it')).status).toBe('failed')
    expect((await s.get(id)).markdown).toBe('')
  })
  it('Stop during a draft ends the wait at once, passes the signal on, and saves nothing when the call returns late', async () => {
    const store = createMemoryArticleStore()
    let release: (v: unknown) => void = () => undefined
    let seen: AbortSignal | undefined
    const llm = { callChatStructured: (_m: unknown, _t: unknown, o?: { signal?: AbortSignal }) => { seen = o?.signal; return new Promise((r) => { release = r }) } } as unknown as ILLMClient
    const s = new ArticleService({ store, llm, now: () => NOW, newId: () => 'art1', modelName: 'checker-1' })
    const id = await s.create('Post', '')
    const stop = new AbortController()
    const run = s.draftFromChat(id, 'Write it', undefined, false, stop.signal)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toBe(stop.signal)
    stop.abort()
    await expect(run).rejects.toMatchObject({ name: 'TurnAbortedError' })
    release({ content: JSON.stringify({ name: 'N', markdown: '# N\nLate.' }) })
    await new Promise((r) => setTimeout(r, 0))
    expect((await s.get(id)).markdown).toBe('')
  })
  it('Stop during an edit leaves the article and its suggestions as they were', async () => {
    const { svc: s } = svc({ edits: () => ({ suggestions: [] }) })
    const id = await s.create('Post', MD)
    const stop = new AbortController()
    stop.abort()
    await expect(s.editFromChat(id, 'Tighten the intro', undefined, stop.signal)).rejects.toMatchObject({ name: 'TurnAbortedError' })
    const b = await s.get(id)
    expect(b.markdown).toBe(MD)
    expect(b.meta.suggestions).toEqual([])
  })
  it('the outline: saved first, then the headings are reworked and each section keeps its text', async () => {
    const { svc: s } = svc({ outline: { outline: '# Post\n## Conclusion\n## Latency' } })
    const id = await s.create('Post', MD)
    const r = await s.editOutlineFromChat(id, 'Put the conclusion before latency')
    expect(r.status).toBe('applied')
    expect(r.after).toBe('# Post\n## Conclusion\n## Latency')
    const b = await s.get(id)
    expect(b.markdown.indexOf('## Conclusion')).toBeLessThan(b.markdown.indexOf('## Latency'))
    expect(b.markdown).toContain('So p99 stays under 20 ms.')
    expect(b.snapshots.find((x) => x.label === r.savedAs)?.markdown).toBe(MD)
  })
  it('an outline that comes back unchanged is reported as nothing to do', async () => {
    const { svc: s } = svc({ outline: { outline: '# Post\n## Latency\n## Conclusion' } })
    const id = await s.create('Post', MD)
    expect((await s.editOutlineFromChat(id, 'Leave it')).status).toBe('nothing')
  })
})

describe('a draft typed as it is written', () => {
  const streaming = (json: string, calls: { signal?: AbortSignal }[] = []): ILLMClient => ({
    callChat: async function* (_m: unknown, o?: { signal?: AbortSignal }) { calls.push({ signal: o?.signal }); for (let i = 0; i < json.length; i += 7) yield json.slice(i, i + 7) },
  }) as unknown as ILLMClient
  it('hands the article over as it grows, then stores the finished text and name', async () => {
    const json = JSON.stringify({ name: 'Fast posts', markdown: '# Fast\n\n## Intro\n"Quoted" and a é.\n' })
    const s = new ArticleService({ store: createMemoryArticleStore(), llm: streaming(json), now: () => NOW, newId: () => 'a1', modelName: 'm' })
    const id = await s.create('New article', '')
    const seen: string[] = []
    const r = await s.draftFromChat(id, 'Write it', undefined, true, undefined, (t) => seen.push(t))
    expect(r).toMatchObject({ status: 'drafted', name: 'Fast posts' })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen.every((t, i) => i === 0 || t.startsWith(seen[i - 1]) || seen[i - 1].startsWith(t))).toBe(true)
    expect(seen.at(-1)).toBe('# Fast\n\n## Intro\n"Quoted" and a é.\n')
    expect((await s.get(id)).markdown).toBe('# Fast\n\n## Intro\n"Quoted" and a é.\n')
  })
})

describe('partialJsonString', () => {
  it('reads a string value that is still being written', async () => {
    const { partialJsonString } = await import('./article-draft.js')
    expect(partialJsonString('{"name":"A"', 'markdown')).toBeUndefined()
    expect(partialJsonString('{"name":"A","markdown": "# T\\nLine', 'markdown')).toBe('# T\nLine')
    expect(partialJsonString('{"markdown":"cut \\', 'markdown')).toBe('cut ')
    expect(partialJsonString('{"markdown":"a\\u00', 'markdown')).toBe('a')
    expect(partialJsonString('{"markdown":"say \\"hi\\" \\u00e9","x":1}', 'markdown')).toBe('say "hi" é')
  })
})
