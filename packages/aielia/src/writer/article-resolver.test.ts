import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { removeLink } from './article-rules.js'
import { assessSourceChange, linkedSectionIds, resolveChange } from './article-resolver.js'

const NOW = '2026-10-16T10:00:00.000Z'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const MD = '# Post\n\nIntro: the limiter keeps p99 under 20 ms.\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Memory\n\nIt uses 40 MB.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'

function build(): ArticleMeta {
  const sections = reconcileSections([], MD, ids).sections
  return { ...createArticleMeta('a1', 'Post'), sections }
}
function client(reply: unknown | Error, seen: { users: string[] } = { users: [] }): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.users.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}
const [post, latency, memory, conclusion] = build().sections.map((s) => s.id)

describe('resolveChange', () => {
  const change = { kind: 'text_edited' as const, sectionIds: [latency], summary: 'p99 is now 41 ms' }

  it('marks the sections the model names as needing review, with its reason, and never the changed section', async () => {
    const reply = { affected: [{ sectionId: post, reason: 'still says under 20 ms', confidence: 0.9 }, { sectionId: conclusion, reason: 'repeats under 20 ms', confidence: 0.9 }, { sectionId: latency, reason: 'itself', confidence: 1 }], newLinks: [] }
    const r = await resolveChange({ meta: build(), markdown: MD, change, now: NOW }, client(reply))
    expect(r.status).toBe('resolved')
    expect(r.flagged.map((f) => f.sectionId).sort()).toEqual([post, conclusion].sort())
    const by = (id: string) => r.meta.sections.find((s) => s.id === id)!.review
    expect(by(post)).toMatchObject({ state: 'needs_review', reason: 'still says under 20 ms', setBy: 'resolver' })
    expect(by(latency).state).toBe('clean')
    expect(by(memory).state).toBe('clean')
  })

  it('adds proposed links with the model\'s confidence, once, and leaves confirmed links alone', async () => {
    const meta = build()
    meta.links.push({ id: 'lk1', from: { type: 'section', id: conclusion }, to: { type: 'section', id: latency }, kind: 'repeats', origin: 'confirmed', at: NOW })
    const reply = { affected: [], newLinks: [{ from: post, to: latency, kind: 'repeats', reason: 'intro restates the figure', confidence: 0.8 }, { from: conclusion, to: latency, kind: 'repeats', reason: 'dup', confidence: 0.9 }] }
    const r = await resolveChange({ meta, markdown: MD, change, now: NOW }, client(reply))
    expect(r.proposedLinks).toHaveLength(1)
    expect(r.proposedLinks[0]).toMatchObject({ origin: 'proposed', confidence: 0.8, kind: 'repeats' })
    expect(r.meta.links).toHaveLength(2)
    expect(removeLink(r.meta, 'lk1', 'resolver')).toMatchObject({ ok: false })
  })

  it('sends linked sections in full and the others only as an opening, wrapped as untrusted', async () => {
    const meta = build()
    meta.links.push({ id: 'lk1', from: { type: 'section', id: conclusion }, to: { type: 'section', id: latency }, kind: 'repeats', origin: 'confirmed', at: NOW })
    const seen = { users: [] as string[] }
    const long = MD.replace('It uses 40 MB.', 'It uses 40 MB. ' + 'x'.repeat(400))
    const sections = reconcileSections(meta.sections, long, ids).sections
    await resolveChange({ meta: { ...meta, sections }, markdown: long, change, now: NOW }, client({ affected: [] }, seen))
    const sent = JSON.parse(seen.users[0])
    expect(linkedSectionIds(meta, [latency])).toEqual(new Set([conclusion]))
    const memText = sent.sections.find((s: { id: string }) => s.id === memory).text as string
    expect(memText).toContain('…')
    expect(memText).toContain('<untrusted_external_content>')
    expect(sent.sections.find((s: { id: string }) => s.id === conclusion).text).not.toContain('…')
  })

  it('reports ids that do not exist instead of applying them, and keeps the article on failure', async () => {
    const r = await resolveChange({ meta: build(), markdown: MD, change, now: NOW }, client({ affected: [{ sectionId: 'nope', reason: 'x' }], newLinks: [{ from: 'nope', to: post }] }))
    expect(r.status).toBe('resolved')
    expect(r.flagged).toEqual([])
    expect(r.skipped).toHaveLength(2)
    const meta = build()
    for (const c of [client(new Error('503')), client('junk'), client({ nope: 1 })]) {
      const f = await resolveChange({ meta, markdown: MD, change, now: NOW }, c)
      expect(f.status).toBe('not_resolved')
      expect(f.meta).toBe(meta)
    }
  })

  it('handles a correction that names no section', async () => {
    const r = await resolveChange({ meta: build(), markdown: MD, change: { kind: 'correction', note: 'p99 is 41 ms', supersedes: '18 ms' }, now: NOW }, client({ affected: [{ sectionId: latency, reason: 'states 18 ms' }, { sectionId: post, reason: 'under 20 ms' }] }))
    expect(r.flagged).toHaveLength(2)
  })
})

describe('assessSourceChange', () => {
  function withClaims(): ArticleMeta {
    const meta = build()
    const base = { sectionId: latency, position: 0, kind: 'factual' as const, author: 'model' as const, authorAt: NOW, confirmed: false, sourceStatus: 'supported' as const }
    meta.claims = [{ ...base, id: 'k1', quote: 'The p99 was 18 ms.' }, { ...base, id: 'k2', quote: 'Run on 8 cores.', sectionId: memory }, { ...base, id: 'k3', quote: 'Unrelated.' }]
    meta.links = ['k1', 'k2'].map((c, i) => ({ id: `l${i}`, from: { type: 'claim' as const, id: c }, to: { type: 'source' as const, id: 'src1' }, kind: 'supported_by', origin: 'confirmed' as const, at: NOW }))
    return meta
  }
  it('flags claims that may be affected and the section of one that is likely wrong; leaves the others', async () => {
    const reply = { impacts: [{ claimId: 'k1', impact: 'likely_wrong', reason: 'now 41 ms' }, { claimId: 'k2', impact: 'none', reason: 'cores unchanged' }] }
    const r = await assessSourceChange({ meta: withClaims(), sourceId: 'src1', before: '18 ms', after: '41 ms', now: NOW }, client(reply))
    expect(r.status).toBe('assessed')
    expect(r.meta.claims.find((c) => c.id === 'k1')!.needsRecheck).toBe(true)
    expect(r.meta.claims.find((c) => c.id === 'k2')!.needsRecheck).toBeUndefined()
    expect(r.meta.sections.find((s) => s.id === latency)!.review).toMatchObject({ state: 'needs_review' })
    expect(r.meta.sections.find((s) => s.id === memory)!.review.state).toBe('clean')
  })
  it('does not call the model when no claim cites the source, and does not guess when the call fails', async () => {
    const seen = { users: [] as string[] }
    expect((await assessSourceChange({ meta: build(), sourceId: 'src1', before: 'a', after: 'b', now: NOW }, client({}, seen))).impacts).toEqual([])
    expect(seen.users).toHaveLength(0)
    const m = withClaims()
    const r = await assessSourceChange({ meta: m, sourceId: 'src1', before: 'a', after: 'b', now: NOW }, client(new Error('x')))
    expect(r.status).toBe('not_assessed')
    expect(r.meta).toBe(m)
  })
})
