import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import type { Claim } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { batchSections, extractClaims } from './article-claims.js'

const NOW = '2026-10-16T10:00:00.000Z'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const MD = '# Title\n\n## Throughput\n\nThe limiter handled 120,000 requests per second. It feels quick.\n\n## Memory\n\nIt uses 40 MB at 10,000 clients.\n'
const sections = reconcileSections([], MD, ids).sections
const throughput = sections[1].id
const memory = sections[2].id

function client(reply: unknown | Error, seen: { calls: number; users: string[] } = { calls: 0, users: [] }): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.calls++
      seen.users.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}

function claim(over: Partial<Claim>): Claim {
  return { id: 'k1', sectionId: throughput, quote: 'The limiter handled 120,000 requests per second.', position: 0, kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'none', ...over }
}

const base = { markdown: MD, sections, now: NOW }

describe('extractClaims', () => {
  it('creates claims with ids, positions and the section the text puts them in', async () => {
    const reply = { claims: [{ quote: 'The limiter handled 120,000 requests per second.', kind: 'factual', matchesId: null, sure: true }, { quote: 'It uses 40 MB at 10,000 clients.', kind: 'factual', matchesId: null, sure: true }, { quote: 'It feels quick.', kind: 'opinion', matchesId: null, sure: true }] }
    const r = await extractClaims({ ...base, claims: [] }, client(reply))
    expect(r.status).toBe('extracted')
    expect(r.added).toHaveLength(3)
    expect(r.claims.map((c) => c.sectionId)).toEqual([throughput, throughput, memory])
    expect(r.claims.every((c) => MD.slice(c.position, c.position + c.quote.length) === c.quote)).toBe(true)
    expect(r.claims.find((c) => c.quote === 'It feels quick.')!.kind).toBe('opinion')
    expect(r.claims.every((c) => !c.confirmed && c.author === 'model' && c.sourceStatus === 'none')).toBe(true)
  })

  it('keeps the id on a sure match, and resets the check when the wording changed', async () => {
    const prev = claim({ sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'The limiter handled 120,000 requests per second.', sourceFingerprints: {} } })
    const edited = MD.replace('The limiter handled', 'Our limiter handled')
    const secs = reconcileSections(sections, edited, ids).sections
    const reply = { claims: [{ quote: 'Our limiter handled 120,000 requests per second.', kind: 'factual', matchesId: 'k1', sure: true }] }
    const r = await extractClaims({ markdown: edited, sections: secs, claims: [prev], now: NOW }, client(reply))
    expect(r.matched).toEqual(['k1'])
    expect(r.claims[0]).toMatchObject({ id: 'k1', quote: 'Our limiter handled 120,000 requests per second.', sourceStatus: 'not_checked' })
    expect(r.claims[0].check).toBeUndefined()
    expect(r.added).toEqual([])
  })

  it('keeps an unsure match and marks it for a check instead of dropping or re-creating it', async () => {
    const reply = { claims: [{ quote: 'The limiter handled 120,000 requests per second.', kind: 'factual', matchesId: 'k1', sure: false }] }
    const r = await extractClaims({ ...base, claims: [claim({})] }, client(reply))
    expect(r.flagged).toEqual(['k1'])
    expect(r.claims).toHaveLength(1)
    expect(r.claims[0]).toMatchObject({ id: 'k1', needsRecheck: true })
  })

  it('never drops a confirmed claim silently; drops an unconfirmed one but reports it', async () => {
    const confirmed = claim({ id: 'k1', confirmed: true, quote: 'Gone claim A.' })
    const loose = claim({ id: 'k2', quote: 'Gone claim B.' })
    const r = await extractClaims({ ...base, claims: [confirmed, loose] }, client({ claims: [] }))
    expect(r.claims.map((c) => c.id)).toEqual(['k1'])
    expect(r.claims[0].needsRecheck).toBe(true)
    expect(r.flagged).toEqual(['k1'])
    expect(r.removed.map((c) => c.id)).toEqual(['k2'])
  })

  it('does not let the model change what the writer confirmed', async () => {
    const reply = { claims: [{ quote: 'It feels quick.', kind: 'factual', matchesId: 'k1', sure: true }] }
    const r = await extractClaims({ ...base, claims: [claim({ id: 'k1', confirmed: true, kind: 'opinion', quote: 'It feels quick.' })] }, client(reply))
    expect(r.claims[0]).toMatchObject({ id: 'k1', kind: 'opinion', confirmed: true })
  })

  it('reports a quote that is not in the text instead of storing an unanchorable claim', async () => {
    const reply = { claims: [{ quote: 'Made up sentence.', kind: 'factual', matchesId: null, sure: true }] }
    const r = await extractClaims({ ...base, claims: [] }, client(reply))
    expect(r.claims).toEqual([])
    expect(r.unanchored).toEqual(['Made up sentence.'])
  })

  it('matches a known id only once; the second use becomes a new claim', async () => {
    const reply = { claims: [{ quote: 'The limiter handled 120,000 requests per second.', kind: 'factual', matchesId: 'k1', sure: true }, { quote: 'It uses 40 MB at 10,000 clients.', kind: 'factual', matchesId: 'k1', sure: true }] }
    const r = await extractClaims({ ...base, claims: [claim({})] }, client(reply))
    expect(r.matched).toEqual(['k1'])
    expect(r.added).toHaveLength(1)
    expect(r.claims).toHaveLength(2)
  })

  it('leaves the claims as they were, and says so, when the call fails or the reply is unusable', async () => {
    const claims = [claim({})]
    for (const c of [client(new Error('503')), client('not json'), client({ nope: 1 })]) {
      const r = await extractClaims({ ...base, claims }, c)
      expect(r.status).toBe('not_extracted')
      expect(r.claims).toEqual(claims)
    }
  })

  it('shows the model each batch with only that batch\'s known claims', async () => {
    const seen = { calls: 0, users: [] as string[] }
    const big = '# T\n\n## A\n\n' + 'a'.repeat(50) + '\n\n## B\n\n' + 'b'.repeat(50) + '\n'
    const secs = reconcileSections([], big, ids).sections
    expect(batchSections(secs, big, 80).length).toBeGreaterThan(1)
    await extractClaims({ markdown: big, sections: secs, claims: [], now: NOW }, client({ claims: [] }, seen))
    expect(seen.calls).toBe(1) // default bound is large: one batch
    expect(JSON.parse(seen.users[0]).sections).toHaveLength(3)
  })
})
