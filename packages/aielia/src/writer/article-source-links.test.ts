import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta, type Claim } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { removeLink } from './article-rules.js'
import { createSource } from './article-sources.js'
import { attachSourceToText, claimsInRange, proposeSourceLinks, textUnitAt } from './article-source-links.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms. It is quick, see section 4.5 for details. Done!\n\nSecond paragraph here.\n'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const build = (claims: Claim[] = []): ArticleMeta => ({ ...createArticleMeta('a1', 'Post'), sections: reconcileSections([], MD, ids).sections, sources: [createSource({ id: 'src1', kind: 'upload', address: 'bench.txt', passage: 'p99: 18 ms', now: NOW })], claims })
const at = (needle: string): number => MD.indexOf(needle)
const claim = (over: Partial<Claim>): Claim => ({ id: 'k1', sectionId: 's2', quote: 'The p99 was 18 ms.', position: at('The p99 was 18 ms.'), kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'none', ...over })

describe('textUnitAt', () => {
  it('is the selection when there is one, trimmed', () => {
    expect(textUnitAt(MD, at('p99 was'), at('18 ms') + 5)).toEqual({ start: at('p99 was'), end: at('18 ms') + 5, quote: 'p99 was 18 ms' })
    expect(textUnitAt(MD, at('The p99') - 0, at('The p99') + 4 + 1)?.quote).toBe('The p')
  })
  it('is the sentence around the cursor, without splitting on a decimal point, and not crossing a paragraph', () => {
    expect(textUnitAt(MD, at('18 ms'))?.quote).toBe('The p99 was 18 ms.')
    expect(textUnitAt(MD, at('4.5'))?.quote).toBe('It is quick, see section 4.5 for details.')
    expect(textUnitAt(MD, at('Done'))?.quote).toBe('Done!')
    expect(textUnitAt(MD, at('Second'))?.quote).toBe('Second paragraph here.')
  })
  it('treats a heading line as its own unit and gives nothing for blank space', () => {
    expect(textUnitAt(MD, at('Latency'))?.quote).toBe('## Latency')
    expect(textUnitAt('a\n\n\n\nb', 3)).toBeUndefined()
    expect(textUnitAt('   ', 1, 2)).toBeUndefined()
  })
})

describe('claimsInRange', () => {
  it('finds factual claims that overlap the range, and no others', () => {
    const meta = build([claim({}), claim({ id: 'k2', quote: 'Second paragraph here.', position: at('Second') }), claim({ id: 'k3', kind: 'opinion', quote: 'It is quick', position: at('It is quick') })])
    expect(claimsInRange(meta, { start: at('18 ms'), end: at('18 ms') + 1 }).map((c) => c.id)).toEqual(['k1'])
    expect(claimsInRange(meta, { start: at('It is'), end: at('It is') + 3 })).toEqual([])
  })
})

describe('attachSourceToText', () => {
  it('attaches to the claim at the cursor with a hand-drawn link', () => {
    const r = attachSourceToText(build([claim({})]), MD, { start: at('18 ms'), end: at('18 ms') }, 'src1', NOW)
    expect(r.ok && r.claimIds).toEqual(['k1'])
    if (!r.ok) return
    expect(r.createdClaim).toBe(false)
    expect(r.meta.links[0]).toMatchObject({ kind: 'supported_by', origin: 'drawn', from: { id: 'k1' }, to: { id: 'src1' } })
    expect(r.meta.claims[0].sourceStatus).toBe('attached')
    expect(removeLink(r.meta, r.meta.links[0].id, 'assistant')).toMatchObject({ ok: false })
  })
  it('creates a confirmed claim for the sentence when there is none, and does not attach twice', () => {
    const first = attachSourceToText(build(), MD, { start: at('Second'), end: at('Second') }, 'src1', NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.createdClaim).toBe(true)
    expect(first.meta.claims[0]).toMatchObject({ quote: 'Second paragraph here.', author: 'writer', confirmed: true, kind: 'factual', sourceStatus: 'attached' })
    const again = attachSourceToText(first.meta, MD, { start: at('Second'), end: at('Second') }, 'src1', NOW)
    expect(again.ok && again.meta.links).toHaveLength(1)
  })
  it('turns a proposed link into a drawn one when the writer attaches it themselves, and refuses an unknown source or empty text', () => {
    const meta = { ...build([claim({})]), links: [{ id: 'lk1', from: { type: 'claim' as const, id: 'k1' }, to: { type: 'source' as const, id: 'src1' }, kind: 'supported_by', origin: 'proposed' as const, at: NOW }] }
    const r = attachSourceToText(meta, MD, { start: at('18 ms'), end: at('18 ms') }, 'src1', NOW)
    expect(r.ok && r.meta.links[0].origin).toBe('drawn')
    expect(attachSourceToText(meta, MD, { start: 1, end: 1 }, 'nope', NOW)).toMatchObject({ ok: false })
    expect(attachSourceToText(build(), '   ', { start: 1, end: 1 }, 'src1', NOW)).toMatchObject({ ok: false })
  })
})

function client(reply: unknown | Error): ILLMClient {
  return { callChatStructured: async () => { if (reply instanceof Error) throw reply; return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } } } as unknown as ILLMClient
}

describe('proposeSourceLinks', () => {
  it('proposes links to the claims a dropped source bears on, with its reason, for the writer to confirm', async () => {
    const meta = build([claim({}), claim({ id: 'k2', quote: 'Second paragraph here.', position: at('Second') })])
    const r = await proposeSourceLinks({ meta, sourceId: 'src1', now: NOW }, client({ claims: [{ claimId: 'k1', relation: 'supports', reason: 'same 18 ms', confidence: 0.9 }, { claimId: 'zzz', relation: 'supports' }] }))
    expect(r.added).toHaveLength(1)
    expect(r.added[0]).toMatchObject({ origin: 'proposed', kind: 'supported_by', confidence: 0.9, reason: 'supports: same 18 ms' })
    expect(r.skipped).toHaveLength(1)
  })
  it('does not call the model without a passage or a claim, and leaves the article alone on failure', async () => {
    const noPassage = { ...build([claim({})]), sources: [createSource({ id: 'src1', kind: 'web', address: 'https://x', now: NOW })] }
    expect((await proposeSourceLinks({ meta: noPassage, sourceId: 'src1', now: NOW }, client(new Error('should not be called')))).status).toBe('proposed')
    expect((await proposeSourceLinks({ meta: build(), sourceId: 'src1', now: NOW }, client(new Error('should not be called')))).status).toBe('proposed')
    const m = build([claim({})])
    for (const c of [client(new Error('503')), client('junk'), client({ nope: 1 })]) {
      const r = await proposeSourceLinks({ meta: m, sourceId: 'src1', now: NOW }, c)
      expect(r.status).toBe('failed')
      expect(r.meta).toBe(m)
    }
  })
})
