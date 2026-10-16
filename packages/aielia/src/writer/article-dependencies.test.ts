import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { removeLink } from './article-rules.js'
import { addDrawnLink, dependenciesOf, proposeDependencies, wouldCycle } from './article-dependencies.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\nIntro says p99 is under 20 ms.\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const meta = (): ArticleMeta => ({ ...createArticleMeta('a1', 'Post'), sections: reconcileSections([], MD, ids).sections })
const [post, latency, conclusion] = meta().sections.map((s) => s.id)
function client(reply: unknown | Error, seen: { users: string[] } = { users: [] }): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.users.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}

describe('addDrawnLink', () => {
  it('records a hand-drawn link the assistant can never remove', () => {
    const r = addDrawnLink(meta(), conclusion, latency, 'repeats', NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link).toMatchObject({ origin: 'drawn', kind: 'repeats' })
    expect(removeLink(r.meta, r.link.id, 'assistant')).toMatchObject({ ok: false })
    expect(removeLink(r.meta, r.link.id, 'writer')).toMatchObject({ ok: true })
  })
  it('refuses itself, unknown sections, duplicates and circles of rests-on, with a reason', () => {
    const m = meta()
    expect(addDrawnLink(m, latency, latency, 'rests_on', NOW)).toMatchObject({ ok: false })
    expect(addDrawnLink(m, 'nope', latency, 'rests_on', NOW)).toMatchObject({ ok: false })
    const a = addDrawnLink(m, conclusion, latency, 'rests_on', NOW)
    if (!a.ok) throw new Error('setup')
    expect(addDrawnLink(a.meta, conclusion, latency, 'rests_on', NOW)).toMatchObject({ ok: false, reason: 'That link already exists.' })
    const circle = addDrawnLink(a.meta, latency, conclusion, 'rests_on', NOW)
    expect(circle).toMatchObject({ ok: false })
    expect((circle as { reason: string }).reason).toContain('circle')
    // restating each other is not a circle of reliance
    expect(addDrawnLink(a.meta, latency, conclusion, 'repeats', NOW).ok).toBe(true)
  })
  it('finds a circle through several links', () => {
    let m = meta()
    for (const [f, t] of [[post, latency], [latency, conclusion]] as const) {
      const r = addDrawnLink(m, f, t, 'rests_on', NOW)
      if (!r.ok) throw new Error('setup')
      m = r.meta
    }
    expect(wouldCycle(m, conclusion, post)).toBe(true)
    expect(wouldCycle(m, post, conclusion)).toBe(false)
  })
})

describe('dependenciesOf', () => {
  it('splits what a section uses from what uses it, ignoring other link kinds', () => {
    let m = meta()
    const a = addDrawnLink(m, conclusion, latency, 'rests_on', NOW)
    if (!a.ok) throw new Error('setup')
    m = a.meta
    m = { ...m, links: [...m.links, { id: 'lk9', from: { type: 'claim', id: 'k1' }, to: { type: 'source', id: 's' }, kind: 'supported_by', origin: 'drawn', at: NOW }] }
    expect(dependenciesOf(m, conclusion).uses).toHaveLength(1)
    expect(dependenciesOf(m, latency).usedBy.map((l) => l.from.id)).toEqual([conclusion])
    expect(dependenciesOf(m, post)).toEqual({ uses: [], usedBy: [] })
  })
})

describe('proposeDependencies', () => {
  it('adds the links the model finds as proposals, with its reason and confidence', async () => {
    const reply = { links: [{ from: conclusion, to: latency, kind: 'repeats', reason: 'repeats the 20 ms bound', confidence: 0.9 }, { from: post, to: latency, kind: 'rests_on', reason: 'the opening rests on the figure', confidence: 2 }] }
    const r = await proposeDependencies({ meta: meta(), markdown: MD, now: NOW }, client(reply))
    expect(r.status).toBe('proposed')
    expect(r.added).toHaveLength(2)
    expect(r.added[0]).toMatchObject({ origin: 'proposed', kind: 'repeats', confidence: 0.9, reason: 'repeats the 20 ms bound' })
    expect(r.added[1].confidence).toBe(1)
  })
  it('drops what it cannot use, and reports it: unknown sections, itself, duplicates, circles', async () => {
    const base = addDrawnLink(meta(), conclusion, latency, 'rests_on', NOW)
    if (!base.ok) throw new Error('setup')
    const reply = { links: [{ from: 'nope', to: latency }, { from: latency, to: latency }, { from: conclusion, to: latency, kind: 'rests_on' }, { from: latency, to: conclusion, kind: 'rests_on' }, { from: post, to: latency, kind: 'repeats' }] }
    const r = await proposeDependencies({ meta: base.meta, markdown: MD, now: NOW }, client(reply))
    expect(r.added).toHaveLength(1)
    expect(r.skipped).toHaveLength(3)
  })
  it('shows the model the text as untrusted data and the links already recorded', async () => {
    const base = addDrawnLink(meta(), conclusion, latency, 'rests_on', NOW)
    if (!base.ok) throw new Error('setup')
    const seen = { users: [] as string[] }
    await proposeDependencies({ meta: base.meta, markdown: MD, now: NOW }, client({ links: [] }, seen))
    const sent = JSON.parse(seen.users[0])
    expect(sent.sections[0].text).toContain('<untrusted_external_content>')
    expect(sent.links).toEqual([{ from: conclusion, to: latency, kind: 'rests_on' }])
  })
  it('keeps the article as it was on failure, and needs nothing to say for a one-section article', async () => {
    const m = meta()
    for (const c of [client(new Error('503')), client('junk'), client({ nope: 1 })]) {
      const r = await proposeDependencies({ meta: m, markdown: MD, now: NOW }, c)
      expect(r.status).toBe('failed')
      expect(r.meta).toBe(m)
    }
    const one = { ...m, sections: m.sections.slice(0, 1) }
    expect((await proposeDependencies({ meta: one, markdown: MD, now: NOW }, client(new Error('should not be called')))).status).toBe('proposed')
  })
})
