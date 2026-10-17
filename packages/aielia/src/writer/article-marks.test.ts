import { describe, it, expect } from 'vitest'
import { createArticleMeta, type Claim } from './article-model.js'
import { claimMarks } from './article-marks.js'

const MD = '# Post\n\nThe p99 was 18 ms. We ran it on 8 cores. It is fast.\n'
const claim = (id: string, quote: string, extra: Partial<Claim> = {}): Claim => ({ id, sectionId: 's1', quote, position: MD.indexOf(quote), kind: 'factual', author: 'model', authorAt: 'x', confirmed: false, sourceStatus: 'none', ...extra }) as Claim

describe('claim marks', () => {
  it('marks factual claims where the quote stands, in three tones', () => {
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
      ['c2', 'bad', 'We ran it on 8 cores.'],
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
  it('is marked as not supported, with its own status', () => {
    const md = 'The p99 was 18 ms.'
    const base = { id: 'c1', sectionId: 's1', quote: md, position: 0, kind: 'factual' as const, author: 'writer' as const, authorAt: 'x', confirmed: true, sourceStatus: 'none' as const }
    const meta = { claims: [{ ...base, lookup: { at: '2026-10-17T00:00:00Z', claimText: md, outcome: 'none_supported' as const, tried: [] } }], sources: [] } as never
    expect(claimMarks(meta, md)).toEqual([{ start: 0, end: md.length, claimId: 'c1', tone: 'bad', status: 'none_found' }])
    const unavailable = { claims: [{ ...base, lookup: { at: 'x', claimText: md, outcome: 'unavailable' as const, tried: [] } }], sources: [] } as never
    expect(claimMarks(unavailable, md)[0]).toMatchObject({ tone: 'look', status: 'none' })
  })
})
