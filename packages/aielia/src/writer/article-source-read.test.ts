import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import { effectiveSourceStatus } from './article-rules.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n'
const llm = (impacts: unknown[]): ILLMClient => ({ callChatStructured: async () => ({ content: JSON.stringify({ impacts }) }) }) as unknown as ILLMClient

async function setup(pages: Record<string, string | Error>, impacts: unknown[] = []) {
  const store = createMemoryArticleStore()
  const calls: string[] = []
  const svc = new ArticleService({
    store, llm: llm(impacts), now: () => NOW,
    fetchWeb: async (u) => { calls.push(u); const p = pages[u]; if (p instanceof Error) throw p; if (p === undefined) throw new Error('404'); return p },
  })
  const id = await svc.create('Post', MD)
  return { svc, id, calls, pages }
}

describe('reading a web source', () => {
  it('stores the page text as the passage on first read, and the same text later keeps it current', async () => {
    const { svc, id, pages } = await setup({ 'https://x.test/a': 'p99 is 18 ms.' })
    const sid = await svc.addSource(id, { kind: 'web', address: 'https://x.test/a' })
    expect((await svc.readSource(id, sid)).status).toBe('read')
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'p99 is 18 ms.', freshness: 'current' })
    pages['https://x.test/a'] = 'p99   is 18 ms.'
    expect((await svc.readSource(id, sid)).status).toBe('unchanged')
  })
  it('holds changed text until accepted, marks citing claims for recheck, and keeps the stored passage meanwhile', async () => {
    const { svc, id, pages } = await setup({ 'https://x.test/a': 'p99 is 18 ms.' }, [{ claimId: 'c1', impact: 'likely_wrong', reason: 'now 30 ms' }])
    const sid = await svc.addSource(id, { kind: 'web', address: 'https://x.test/a' })
    await svc.readSource(id, sid)
    const b = await svc.get(id)
    const claim = { id: 'c1', sectionId: b.meta.sections[1].id, quote: 'The p99 was 18 ms.', position: b.markdown.indexOf('The p99'), kind: 'factual' as const, author: 'writer' as const, authorAt: NOW, confirmed: true, sourceStatus: 'supported' as const, check: { claimText: 'The p99 was 18 ms.', sourceFingerprints: { [sid]: b.meta.sources[0].fingerprint } } }
    // a claim cited by a supported_by link
    const store = (svc as unknown as { store: { save(id: string, b: unknown): Promise<void> } }).store
    await store.save(id, { ...b, meta: { ...b.meta, claims: [claim as never], links: [{ id: 'l1', from: { type: 'claim', id: 'c1' }, to: { type: 'source', id: sid }, kind: 'supported_by', origin: 'drawn', at: NOW }] } })
    pages['https://x.test/a'] = 'p99 is now 30 ms.'
    const r = await svc.readSource(id, sid)
    expect(r).toMatchObject({ status: 'changed', impacts: [{ claimId: 'c1', impact: 'likely_wrong' }] })
    const after = await svc.get(id)
    expect(after.meta.sources[0]).toMatchObject({ passage: 'p99 is 18 ms.', fetchedPassage: 'p99 is now 30 ms.', freshness: 'changed' })
    expect(after.meta.claims[0].needsRecheck).toBe(true)
    expect(after.meta.sections[1].review.state).toBe('needs_review')
    expect(effectiveSourceStatus(after.meta.claims[0], after.meta.sources)).toBe('stale')
    expect(await svc.acceptSourceChange(id, sid)).toEqual({ ok: true })
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'p99 is now 30 ms.', freshness: 'current', fetchedPassage: undefined })
    expect(await svc.acceptSourceChange(id, sid)).toMatchObject({ ok: false })
  })
  it('says why when it cannot read: unreachable page, empty page, no fetcher, not a link', async () => {
    const { svc, id } = await setup({ 'https://x.test/down': new Error('HTTP 503'), 'https://x.test/empty': '   ' })
    const down = await svc.addSource(id, { kind: 'web', address: 'https://x.test/down' })
    expect(await svc.readSource(id, down)).toMatchObject({ status: 'unreachable', reason: 'HTTP 503' })
    expect((await svc.get(id)).meta.sources[0].freshness).toBe('unreachable')
    const empty = await svc.addSource(id, { kind: 'web', address: 'https://x.test/empty' })
    expect(await svc.readSource(id, empty)).toMatchObject({ status: 'unreachable' })
    const word = await svc.addSource(id, { kind: 'say_so', passage: 'I measured it' })
    expect((await svc.readSource(id, word)).status).toBe('not_a_link')
    const bare = new ArticleService({ store: createMemoryArticleStore(), llm: llm([]), now: () => NOW })
    const id2 = await bare.create('P', MD)
    const s2 = await bare.addSource(id2, { kind: 'web', address: 'https://x.test/a' })
    expect(await bare.readSource(id2, s2)).toMatchObject({ status: 'unavailable' })
  })
  it('refuses an address that is not http(s)', async () => {
    const { svc, id, calls } = await setup({})
    const s = await svc.addSource(id, { kind: 'web', address: 'file:///etc/passwd' })
    expect((await svc.readSource(id, s)).status).toBe('not_a_link')
    expect(calls).toEqual([])
  })
})
