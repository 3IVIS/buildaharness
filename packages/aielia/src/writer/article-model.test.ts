import { describe, it, expect } from 'vitest'
import { ARTICLE_META_VERSION, createArticleMeta, parseArticleMeta, type ArticleMeta, type Claim, type Source } from './article-model.js'
import { parseSections, reconcileSections } from './article-sections.js'
import { checkIntegrity, computeReadiness, confirmLink, createSnapshot, editClaimText, effectiveSourceStatus, removeLink, restoreSnapshot, setSectionReview } from './article-rules.js'

const NOW = '2026-10-16T10:00:00.000Z'
const ids = (taken: ReadonlySet<string>): string => {
  let n = taken.size + 1
  while (taken.has(`s${n}`)) n++
  return `s${n}`
}

const MD = '# Title\n\nIntro text.\n\n## Throughput\n\nIt is fast.\n\n## Memory\n\nIt is small.\n'

function claim(over: Partial<Claim> = {}): Claim {
  return { id: 'k1', sectionId: 's2', quote: 'It is fast.', position: 30, kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'none', ...over }
}
function source(over: Partial<Source> = {}): Source {
  return { id: 'src1', kind: 'upload', passage: '120,000 req/s', fingerprint: 'f1', trust: 'normal', freshness: 'current', ...over }
}
function metaWith(over: Partial<ArticleMeta>): ArticleMeta {
  return { ...createArticleMeta('a1', 'Title'), ...over }
}

describe('parseArticleMeta', () => {
  it('round-trips a valid file', () => {
    const m = metaWith({ claims: [claim()], sources: [source()] })
    const r = parseArticleMeta(JSON.parse(JSON.stringify(m)))
    expect(r.ok).toBe(true)
  })
  it('refuses a newer version, a missing version and damage, with a message, instead of loading partly', () => {
    const newer = parseArticleMeta({ ...createArticleMeta('a', 't'), formatVersion: ARTICLE_META_VERSION + 1 })
    expect(newer).toMatchObject({ ok: false })
    expect((newer as { reason: string }).reason).toContain('newer')
    expect(parseArticleMeta({})).toMatchObject({ ok: false })
    expect(parseArticleMeta(null)).toMatchObject({ ok: false })
    const damaged = parseArticleMeta({ ...createArticleMeta('a', 't'), claims: [{ id: 'k' }] })
    expect(damaged).toMatchObject({ ok: false })
    expect((damaged as { reason: string }).reason).toContain('claims')
  })
})

describe('sections', () => {
  it('finds headings with their spans, ignores fenced code, and treats text before the first heading as a lead', () => {
    const p = parseSections('Lead line.\n\n# A\n\n```\n# not a heading\n```\n\n## B\n')
    expect(p.map((h) => [h.heading, h.level])).toEqual([['', 0], ['A', 1], ['B', 2]])
    expect(p[0]).toMatchObject({ start: 0 })
    expect(p[1].end).toBe(p[2].start)
  })
  it('has no lead section when the text starts with a heading', () => {
    expect(parseSections('# A\n\ntext\n').map((h) => h.heading)).toEqual(['A'])
  })
  it('keeps ids when headings are unchanged and updates the spans', () => {
    const first = reconcileSections([], MD, ids)
    expect(first.sections.map((s) => s.heading)).toEqual(['Title', 'Throughput', 'Memory'])
    const edited = MD.replace('Intro text.', 'A much longer intro text than before.')
    const second = reconcileSections(first.sections, edited, ids)
    expect(second.sections.map((s) => s.id)).toEqual(first.sections.map((s) => s.id))
    expect(second.sections[1].span.start).toBeGreaterThan(first.sections[1].span.start)
    expect(second.created).toEqual([])
    expect(second.removed).toEqual([])
  })
  it('keeps the id of a renamed heading in an otherwise unchanged outline', () => {
    const first = reconcileSections([], MD, ids)
    const second = reconcileSections(first.sections, MD.replace('## Memory', '## Memory use'), ids)
    expect(second.sections[2].id).toBe(first.sections[2].id)
    expect(second.kept.find((k) => k.id === first.sections[2].id)?.renamedFrom).toBe('Memory')
  })
  it('does not guess when it is unsure: new sections get new ids and the old record is reported as removed', () => {
    const first = reconcileSections([], MD, ids)
    const second = reconcileSections(first.sections, '# Title\n\n## Something new\n\n## Another\n', ids)
    expect(second.created.length).toBe(2)
    expect(second.removed.map((s) => s.heading).sort()).toEqual(['Memory', 'Throughput'])
    expect(second.sections[0].id).toBe(first.sections[0].id)
  })
  it('sets parents from heading levels and carries review state over', () => {
    const first = reconcileSections([], MD, ids)
    expect(first.sections[1].parentId).toBe(first.sections[0].id)
    const flagged = first.sections.map((s) => (s.heading === 'Memory' ? { ...s, review: { state: 'needs_review' as const, reason: 'figure changed' } } : s))
    const again = reconcileSections(flagged, MD + '\nmore\n', ids)
    expect(again.sections[2].review).toMatchObject({ state: 'needs_review', reason: 'figure changed' })
  })
})

describe('claims never look more checked than they are', () => {
  const checked = (over: Partial<Claim> = {}): Claim =>
    claim({ sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'matches', claimText: 'It is fast.', sourceFingerprints: { src1: 'f1' } }, ...over })

  it('shows a verdict only for the current text and current stored passages', () => {
    expect(effectiveSourceStatus(checked(), [source()])).toBe('supported')
    expect(effectiveSourceStatus(checked(), [source({ fingerprint: 'f2' })])).toBe('stale')
    expect(effectiveSourceStatus(checked(), [source({ freshness: 'changed' })])).toBe('stale')
    expect(effectiveSourceStatus(checked(), [])).toBe('stale')
    expect(effectiveSourceStatus(checked({ quote: 'It is very fast.' }), [source()])).toBe('not_checked')
    expect(effectiveSourceStatus(checked({ check: undefined }), [source()])).toBe('not_checked')
  })
  it('leaves non-verdict statuses alone', () => {
    expect(effectiveSourceStatus(claim({ sourceStatus: 'none' }), [])).toBe('none')
    expect(effectiveSourceStatus(claim({ sourceStatus: 'attached' }), [])).toBe('attached')
  })
  it('resets the check when the text changes and records who changed it', () => {
    const edited = editClaimText(checked({ author: 'model' }), 'It is quick.', 'writer', NOW)
    expect(edited.sourceStatus).toBe('not_checked')
    expect(edited.check).toBeUndefined()
    expect(edited.author).toBe('mixed')
    expect(editClaimText(claim(), 'It is fast.', 'writer', NOW)).toEqual(claim())
    expect(editClaimText(claim({ sourceStatus: 'none' }), 'x', 'writer', NOW).sourceStatus).toBe('none')
  })
})

describe('review state', () => {
  const m = reconcileSections([], MD, ids)
  const meta = metaWith({ sections: m.sections })
  const sid = m.sections[1].id

  it('lets the resolver mark needs review but not clear it', () => {
    const flagged = setSectionReview(meta, sid, 'needs_review', 'depends on a changed section', 'resolver', NOW)
    expect(flagged.ok).toBe(true)
    if (!flagged.ok) return
    expect(setSectionReview(flagged.meta, sid, 'clean', undefined, 'resolver', NOW)).toMatchObject({ ok: false })
    expect(setSectionReview(flagged.meta, sid, 'being_revised', undefined, 'editor', NOW)).toMatchObject({ ok: false })
    const cleared = setSectionReview(flagged.meta, sid, 'clean', undefined, 'writer', NOW)
    expect(cleared.ok).toBe(true)
  })
  it('does not mutate its input and rejects an unknown section', () => {
    setSectionReview(meta, sid, 'needs_review', 'x', 'resolver', NOW)
    expect(meta.sections[1].review.state).toBe('clean')
    expect(setSectionReview(meta, 'nope', 'clean', undefined, 'writer', NOW)).toMatchObject({ ok: false })
  })
})

describe('links', () => {
  const link = (origin: 'proposed' | 'confirmed' | 'drawn') => ({ id: `l-${origin}`, from: { type: 'section' as const, id: 's1' }, to: { type: 'section' as const, id: 's2' }, kind: 'rests_on', origin, at: NOW })
  const meta = metaWith({ links: [link('proposed'), link('confirmed'), link('drawn')] })

  it('never lets the assistant remove a confirmed or hand-drawn link', () => {
    expect(removeLink(meta, 'l-confirmed', 'assistant')).toMatchObject({ ok: false })
    expect(removeLink(meta, 'l-drawn', 'resolver')).toMatchObject({ ok: false })
    expect(removeLink(meta, 'l-proposed', 'assistant')).toMatchObject({ ok: true })
    const r = removeLink(meta, 'l-confirmed', 'writer')
    expect(r.ok && r.meta.links).toHaveLength(2)
  })
  it('lets only the writer confirm a proposal', () => {
    expect(confirmLink(meta, 'l-proposed', 'assistant')).toMatchObject({ ok: false })
    const r = confirmLink(meta, 'l-proposed', 'writer')
    expect(r.ok && r.meta.links.find((l) => l.id === 'l-proposed')?.origin).toBe('confirmed')
  })
})

describe('integrity', () => {
  it('reports dangling ids and keeps the records', () => {
    const meta = metaWith({
      sections: reconcileSections([], MD, ids).sections,
      claims: [claim({ sectionId: 'gone' })],
      links: [{ id: 'l1', from: { type: 'claim', id: 'k1' }, to: { type: 'source', id: 'nosuch' }, kind: 'supported_by', origin: 'proposed', at: NOW }],
      comments: [{ id: 'wc1', articleId: 'a1', text: 't', state: 'open', conflictsWith: ['wc9'], origin: 'reviewer', anchor: { type: 'claim', id: 'zzz' }, suggestionId: 'sg9', capturedAt: NOW }],
    })
    const problems = checkIntegrity(meta).map((p) => p.where)
    expect(problems).toEqual(expect.arrayContaining(['claim k1', 'link l1', 'comment wc1']))
    expect(checkIntegrity(meta).filter((p) => p.where === 'comment wc1')).toHaveLength(3)
    expect(meta.claims).toHaveLength(1)
  })
  it('finds nothing wrong in a consistent article', () => {
    const sections = reconcileSections([], MD, ids).sections
    expect(checkIntegrity(metaWith({ sections, claims: [claim({ sectionId: sections[1].id })] }))).toEqual([])
  })
})

describe('readiness and snapshots', () => {
  const sections = reconcileSections([], MD, ids).sections
  const meta = metaWith({
    sections: sections.map((s, i) => (i === 2 ? { ...s, review: { state: 'needs_review' as const } } : s)),
    sources: [source()],
    claims: [
      claim({ id: 'k1', sectionId: sections[1].id }),
      claim({ id: 'k2', sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'It is fast.', sourceFingerprints: { src1: 'WRONG' } } }),
      claim({ id: 'k3', kind: 'opinion' }),
      claim({ id: 'k4', sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'It is fast.', sourceFingerprints: { src1: 'f1' } } }),
    ],
    comments: [{ id: 'wc1', articleId: 'a1', text: 'x', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }, { id: 'wc2', articleId: 'a1', text: 'y', state: 'addressed', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }],
  })

  it('counts from the effective status, not the stored one', () => {
    expect(computeReadiness(meta)).toEqual({ unsourcedFactualClaims: 1, staleOrUnsupportedClaims: 1, openComments: 1, sectionsNeedingReview: 1 })
  })
  it('freezes a snapshot so later edits cannot change it, and restoring leaves it untouched', () => {
    const snap = createSnapshot('published', MD, meta, NOW, 'v1')
    expect(snap.readiness.openComments).toBe(1)
    expect(() => {
      ;(snap.meta.claims as Claim[]).push(claim({ id: 'x' }))
    }).toThrow()
    meta.claims.push(claim({ id: 'later' }))
    expect(snap.meta.claims.some((c) => c.id === 'later')).toBe(false)
    const restored = restoreSnapshot(snap)
    restored.meta.title = 'changed'
    expect(snap.meta.title).toBe('Title')
    expect(restored.markdown).toBe(MD)
  })
})
