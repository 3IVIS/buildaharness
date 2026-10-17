import { describe, it, expect } from 'vitest'
import { createArticleMeta, type Claim } from './article-model.js'
import { claimMarks } from './article-marks.js'

const MD = '# Post\n\nThe p99 was 18 ms. We ran it on 8 cores. It is fast.\n'
const claim = (id: string, quote: string, extra: Partial<Claim> = {}): Claim => ({ id, sectionId: 's1', quote, position: MD.indexOf(quote), kind: 'factual', author: 'model', authorAt: 'x', confirmed: false, sourceStatus: 'none', ...extra }) as Claim

describe('claim marks', () => {
  it('marks factual claims where the quote stands: green when backed, orange when a source is still needed, red when a source says the opposite', () => {
    const meta = {
      ...createArticleMeta('a', 'Post'),
      sources: [{ id: 'src1', kind: 'upload' as const, trust: 'normal' as const, freshness: 'current' as const, fingerprint: 'f1', passage: 'p' }],
      claims: [
        claim('c1', 'The p99 was 18 ms.', { sourceStatus: 'supported', check: { claimText: 'The p99 was 18 ms.', sourceFingerprints: { src1: 'f1' } } as never }),
        claim('c2', 'We ran it on 8 cores.', { sourceStatus: 'not_supported', check: { claimText: 'We ran it on 8 cores.', sourceFingerprints: { src1: 'f1' } } as never }),
        claim('c3', 'It is fast.'),
        claim('c4', 'It is fast.', { kind: 'opinion' as never, position: 0 }),
      ],
    }
    const marks = claimMarks(meta, MD)
    expect(marks.map((m) => [m.claimId, m.tone, MD.slice(m.start, m.end)])).toEqual([
      ['c1', 'ok', 'The p99 was 18 ms.'],
      ['c2', 'look', 'We ran it on 8 cores.'],
      ['c3', 'look', 'It is fast.'],
    ])
  })
  it('does not mark a claim whose text has moved, was edited since the save, or overlaps an earlier mark; a claim that needs a recheck is never green', () => {
    const base = createArticleMeta('a', 'Post')
    const c1 = claim('c1', 'The p99 was 18 ms.')
    expect(claimMarks({ ...base, claims: [c1] }, `# Post\n\nChanged. ${MD.slice(8)}`)).toEqual([])
    expect(claimMarks({ ...base, claims: [c1, { ...c1, id: 'c2', position: c1.position + 4, quote: 'p99 was' }] }, MD).map((m) => m.claimId)).toEqual(['c1'])
    const src = { id: 'src1', kind: 'upload' as const, trust: 'normal' as const, freshness: 'current' as const, fingerprint: 'f1', passage: 'p' }
    const ok = { ...c1, sourceStatus: 'supported' as const, needsRecheck: true, check: { claimText: c1.quote, sourceFingerprints: { src1: 'f1' } } as never }
    expect(claimMarks({ ...base, sources: [src], claims: [ok] }, MD)[0].tone).toBe('look')
  })
})

describe('a claim that was searched for and not backed', () => {
  it('stays orange (it still needs a source) with its own status', () => {
    const md = 'The p99 was 18 ms.'
    const base = { id: 'c1', sectionId: 's1', quote: md, position: 0, kind: 'factual' as const, author: 'writer' as const, authorAt: 'x', confirmed: true, sourceStatus: 'none' as const }
    const meta = { claims: [{ ...base, lookup: { at: '2026-10-17T00:00:00Z', claimText: md, outcome: 'none_supported' as const, tried: [] } }], sources: [] } as never
    expect(claimMarks(meta, md)).toEqual([{ start: 0, end: md.length, claimId: 'c1', tone: 'look', status: 'none_found' }])
    const unavailable = { claims: [{ ...base, lookup: { at: 'x', claimText: md, outcome: 'unavailable' as const, tried: [] } }], sources: [] } as never
    expect(claimMarks(unavailable, md)[0]).toMatchObject({ tone: 'look', status: 'none' })
  })
})

describe('the tint covers the whole sentence', () => {
  const TEXT = '# Post\n\nWe tried it. The p99 was 18.5 ms on 8 cores, which is fine. Then we left.\n\nNext paragraph here.\n'
  const base = createArticleMeta('a', 'Post')
  const c = (id: string, quote: string, extra: Partial<Claim> = {}): Claim => ({ id, sectionId: 's1', quote, position: TEXT.indexOf(quote), kind: 'factual', author: 'model', authorAt: 'x', confirmed: false, sourceStatus: 'none', ...extra }) as Claim
  it('extends a partial quote to its sentence, not across a decimal point or into the next sentence', () => {
    const [m] = claimMarks({ ...base, claims: [c('c1', 'p99 was 18.5 ms')] }, TEXT)
    expect(TEXT.slice(m.start, m.end)).toBe('The p99 was 18.5 ms on 8 cores, which is fine.')
  })
  it('gives two claims in one sentence one tint in the worse tone, red above orange above green', () => {
    const src = { id: 'src1', kind: 'upload' as const, trust: 'normal' as const, freshness: 'current' as const, fingerprint: 'f1', passage: 'p' }
    const check = (q: string): never => ({ claimText: q, sourceFingerprints: { src1: 'f1' } }) as never
    const ok = c('c1', 'p99 was 18.5 ms', { sourceStatus: 'supported', check: check('p99 was 18.5 ms') })
    const against = c('c2', 'on 8 cores', { sourceStatus: 'contradicted', check: check('on 8 cores') })
    const marks = claimMarks({ ...base, sources: [src], claims: [ok, against] }, TEXT)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ tone: 'bad', status: 'contradicted' })
    expect(claimMarks({ ...base, sources: [src], claims: [ok] }, TEXT)[0].tone).toBe('ok')
  })
  it('stops at the end of a line, so a heading or list item is not joined to the next one', () => {
    const t = '- one fact\n- two facts\n'
    const [m] = claimMarks({ ...base, claims: [{ ...c('c1', 'one fact'), position: t.indexOf('one fact') }] }, t)
    expect(t.slice(m.start, m.end)).toBe('- one fact'.slice(2))
  })
})
