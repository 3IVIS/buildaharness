import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import { lookupNote, summarizeVerify, verifyTargets } from './article-verify.js'
import type { Claim } from './article-model.js'

const NOW = '2026-10-17T10:00:00.000Z'
const MD = '# Post\n\nThe p99 was 18 ms. The cache holds 100 items.\n'
const claim = (id: string, quote: string, extra: Partial<Claim> = {}): Claim => ({ id, sectionId: 's1', quote, position: MD.indexOf(quote), kind: 'factual', author: 'writer', authorAt: NOW, confirmed: true, sourceStatus: 'none', ...extra })

/** Support replies are chosen by the page text that is sent along; extraction replies list the given claims. */
function client(rules: { verdictFor?: (sources: string) => string }, extracted: Claim[] = []): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')!.content
      const user = messages.find((m) => m.role === 'user')!.content
      if (sys.includes('You check whether a claim from an article')) return { content: JSON.stringify({ verdict: rules.verdictFor?.(user) ?? 'supported', reason: 'by the pages' }) }
      if (sys.includes('You read parts of an article and list the claims')) return { content: JSON.stringify({ claims: extracted.map((c) => ({ quote: c.quote, kind: 'factual', matchesId: null, sure: true })) }) }
      return { content: JSON.stringify({}) }
    },
  } as unknown as ILLMClient
}

async function setup(opts: { search?: (q: string) => Promise<{ title: string; url: string; snippet: string }[]>; pages?: Record<string, string>; verdictFor?: (s: string) => string; withSearch?: boolean }) {
  const store = createMemoryArticleStore()
  const svc = new ArticleService({
    store, llm: client({ verdictFor: opts.verdictFor }), now: () => NOW,
    searchWeb: opts.withSearch === false ? undefined : opts.search ?? (async () => []),
    fetchWeb: opts.withSearch === false ? undefined : async (u) => { const p = opts.pages?.[u]; if (p === undefined) throw new Error('404'); return p },
  })
  const id = await svc.create('Post', MD)
  const b = await svc.get(id)
  const sectionId = b.meta.sections[0].id
  await store.save(id, { ...b, meta: { ...b.meta, claims: [claim('c1', 'The p99 was 18 ms.', { sectionId }), claim('c2', 'The cache holds 100 items.', { sectionId })] } })
  return { svc, id }
}

describe('which claims are verified', () => {
  it('takes factual claims not already supported, in text order, up to the limit, and named claims even when supported', async () => {
    const { svc, id } = await setup({})
    const meta = (await svc.get(id)).meta
    expect(verifyTargets(meta, undefined, 10)).toEqual({ ids: ['c1', 'c2'], leftOver: 0 })
    expect(verifyTargets(meta, undefined, 1)).toEqual({ ids: ['c1'], leftOver: 1 })
    expect(verifyTargets(meta, ['c2'], 10)).toEqual({ ids: ['c2'], leftOver: 0 })
    const opinion = { ...meta, claims: [{ ...meta.claims[0], kind: 'opinion' as const }, meta.claims[1]] }
    expect(verifyTargets(opinion, undefined, 10).ids).toEqual(['c2'])
  })
})

describe('verifying claims', () => {
  it('finds pages, keeps them as proposed sources and records the verdict when they back the claim', async () => {
    const { svc, id } = await setup({
      search: async () => [{ title: 'Bench', url: 'https://x.test/bench', snippet: 's' }],
      pages: { 'https://x.test/bench': 'p99 latency was 18 ms.' },
    })
    const r = await svc.verifyClaims(id, { claimIds: ['c1'] })
    expect(r.entries).toEqual([expect.objectContaining({ claimId: 'c1', outcome: 'supported', found: ['https://x.test/bench'] })])
    const b = await svc.get(id)
    expect(b.meta.sources[0]).toMatchObject({ address: 'https://x.test/bench', passage: 'p99 latency was 18 ms.' })
    expect(b.meta.links[0]).toMatchObject({ origin: 'proposed', kind: 'supported_by' })
    expect(b.meta.claims[0]).toMatchObject({ sourceStatus: 'supported' })
    expect(b.markdown).toBe(MD)
  })
  it('says so, and keeps no pages, when the pages found do not back the claim', async () => {
    const { svc, id } = await setup({
      search: async () => [{ title: 'A', url: 'https://x.test/a', snippet: '' }, { title: 'B', url: 'https://x.test/b', snippet: '' }],
      pages: { 'https://x.test/a': 'unrelated', 'https://x.test/b': 'also unrelated' },
      verdictFor: () => 'not_supported',
    })
    const r = await svc.verifyClaims(id, { claimIds: ['c1'] })
    expect(r.entries[0]).toMatchObject({ outcome: 'no_source_found', found: [] })
    const b = await svc.get(id)
    expect(b.meta.sources).toEqual([])
    expect(b.meta.links).toEqual([])
    expect(b.meta.claims[0]).toMatchObject({ sourceStatus: 'none', lookup: { outcome: 'none_supported', tried: ['https://x.test/a', 'https://x.test/b'] } })
    expect(lookupNote(b.meta.claims[0], false)).toBe('No source found: searched on 2026-10-17, read 2 pages, none of them backs it.')
    expect(lookupNote(b.meta.claims[0], true)).toBeUndefined()
  })
  it('keeps a page that contradicts the claim, so the writer sees it', async () => {
    const { svc, id } = await setup({ search: async () => [{ title: 'A', url: 'https://x.test/a', snippet: '' }], pages: { 'https://x.test/a': 'p99 was 41 ms' }, verdictFor: () => 'contradicted' })
    expect((await svc.verifyClaims(id, { claimIds: ['c1'] })).entries[0]).toMatchObject({ outcome: 'contradicted', found: ['https://x.test/a'] })
    expect((await svc.get(id)).meta.sources).toHaveLength(1)
  })
  it('records an empty search, an unreadable result and a missing search without calling the model', async () => {
    const none = await setup({ search: async () => [] })
    expect((await none.svc.verifyClaims(none.id, { claimIds: ['c1'] })).entries[0].outcome).toBe('no_source_found')
    expect((await none.svc.get(none.id)).meta.claims[0].lookup).toMatchObject({ outcome: 'no_results' })
    const dead = await setup({ search: async () => [{ title: 'A', url: 'https://x.test/a', snippet: '' }], pages: {} })
    expect((await dead.svc.verifyClaims(dead.id, { claimIds: ['c1'] })).entries[0].outcome).toBe('no_source_found')
    expect((await dead.svc.get(dead.id)).meta.sources).toEqual([])
    const off = await setup({ withSearch: false })
    expect((await off.svc.verifyClaims(off.id, { claimIds: ['c1'] })).entries[0].outcome).toBe('cannot_search')
    expect(lookupNote((await off.svc.get(off.id)).meta.claims[0], false)).toContain('Not searched')
  })
  it('does not record "not found" when the search itself failed', async () => {
    const { svc, id } = await setup({ search: async () => { throw new Error('quota') } })
    expect((await svc.verifyClaims(id, { claimIds: ['c1'] })).entries[0]).toMatchObject({ outcome: 'search_failed', reason: 'quota' })
    expect((await svc.get(id)).meta.claims[0].lookup).toBeUndefined()
  })
  it('checks a claim that already has a source against it, with no search, and stops at the limit', async () => {
    let searches = 0
    const { svc, id } = await setup({ search: async () => { searches++; return [] } })
    const sid = await svc.addSource(id, { kind: 'upload', passage: 'p99 was 18 ms' })
    await svc.attachSource(id, 'c1', sid)
    const r = await svc.verifyClaims(id, { limit: 1 })
    expect(r.entries[0]).toMatchObject({ claimId: 'c1', outcome: 'supported' })
    expect(r.leftOver).toBe(1)
    expect(searches).toBe(0)
    expect(summarizeVerify(r)).toBe('Looked at 1 claim: 1 backed. 1 more claims are left; each run takes 1, so run it again for the rest.')
  })
  it('a lookup stops applying once the claim text changes', async () => {
    const { svc, id } = await setup({ search: async () => [] })
    await svc.verifyClaims(id, { claimIds: ['c1'] })
    const c = (await svc.get(id)).meta.claims[0]
    expect(lookupNote({ ...c, quote: 'The p99 was 30 ms.' }, false)).toBeUndefined()
  })
})
