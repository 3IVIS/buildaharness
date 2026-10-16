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
    expect((await s.list())).toEqual([{ id, title: 'Post' }])
    expect((await s.get(id)).meta.sections.map((x) => x.heading)).toEqual(['Post', 'Latency', 'Conclusion'])
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
