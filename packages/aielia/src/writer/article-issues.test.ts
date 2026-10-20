import { describe, it, expect } from 'vitest'
import { createArticleMeta, type ArticleMeta, type Claim } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { createSource } from './article-sources.js'
import { checkableClaims, collectIssues, issueCount, unsupportedClaims } from './article-issues.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Memory\n\nIt uses 40 MB.\n'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const claim = (id: string, over: Partial<Claim> = {}): Claim => ({ id, sectionId: 's2', quote: `Claim ${id}.`, position: 0, kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'none', ...over })
const link = (claimId: string, sourceId: string, origin: 'drawn' | 'proposed' = 'drawn') => ({ id: `l-${claimId}-${sourceId}`, from: { type: 'claim' as const, id: claimId }, to: { type: 'source' as const, id: sourceId }, kind: 'supported_by', origin, at: NOW })

function build(over: Partial<ArticleMeta> = {}): ArticleMeta {
  return { ...createArticleMeta('a1', 'Post'), sections: reconcileSections([], MD, ids).sections, ...over }
}

describe('collectIssues', () => {
  it('has nothing for a clean article', () => {
    expect(collectIssues(build())).toEqual([])
    expect(issueCount([])).toBe(0)
  })

  it('splits claims into those that can be checked now and those that need a source or a rewrite', () => {
    const withPassage = createSource({ id: 'src1', kind: 'upload', passage: 'p99: 18 ms', now: NOW })
    const noPassage = createSource({ id: 'src2', kind: 'web', address: 'https://x', now: NOW })
    const meta = build({
      sources: [withPassage, noPassage],
      claims: [
        claim('k1', { sourceStatus: 'attached' }), // checkable: passage attached
        claim('k2', { sourceStatus: 'attached' }), // not checkable: only a link without a passage
        claim('k3'), // no source at all
        claim('k4', { sourceStatus: 'contradicted' }),
        claim('k5', { kind: 'opinion' }), // never an issue
        claim('k6', { sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'Claim k6.', sourceFingerprints: { src1: withPassage.fingerprint! } } }), // fine
      ],
      links: [link('k1', 'src1'), link('k2', 'src2'), link('k6', 'src1')],
    })
    expect(checkableClaims(meta).map((c) => c.id)).toEqual(['k1'])
    expect(unsupportedClaims(meta).map((c) => c.id).sort()).toEqual(['k2', 'k3', 'k4'])
    const batches = collectIssues(meta)
    expect(batches.map((b) => b.category)).toEqual(['checkable', 'unsupported'])
  })

  it('treats a verdict that no longer applies as checkable again', () => {
    const src = createSource({ id: 'src1', kind: 'upload', passage: 'p99: 18 ms', now: NOW })
    const stale = claim('k1', { sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'Claim k1.', sourceFingerprints: { src1: 'OLD' } } })
    expect(checkableClaims(build({ sources: [src], claims: [stale], links: [link('k1', 'src1')] })).map((c) => c.id)).toEqual(['k1'])
  })

  it('keeps comments in conflict apart from the ones a batch may act on', () => {
    const c = (id: string, label: string, conflictsWith: string[], state: 'open' | 'addressed' = 'open') => ({ id, articleId: 'a1', label, text: `${label} text`, state, conflictsWith, origin: 'reviewer' as const, capturedAt: NOW })
    const batches = collectIssues(build({ comments: [c('wc1', 'C1', []), c('wc2', 'C4', ['wc3']), c('wc3', 'C5', ['wc2']), c('wc4', 'C9', [], 'addressed')] }))
    const comments = batches.find((b) => b.category === 'comments')!
    expect(comments.items.map((i) => i.id)).toEqual(['wc1'])
    expect(comments.needsYourChoice?.map((i) => i.id)).toEqual(['wc2', 'wc3'])
  })

  it('lists pending and stale suggestions, sections to review and only the proposed links', () => {
    const sg = (id: string, state: 'pending' | 'stale' | 'accepted') => ({ id, span: { start: 0, end: 3, quote: 'old' }, replacement: 'new', reason: 'r', proposedBy: 'assistant' as const, state, createdAt: NOW })
    const meta = build({ suggestions: [sg('sg1', 'pending'), sg('sg2', 'stale'), sg('sg3', 'accepted')] })
    meta.sections[1] = { ...meta.sections[1], review: { state: 'needs_review', reason: 'figure changed' } }
    meta.links = [
      { id: 'lk1', from: { type: 'section', id: 's3' }, to: { type: 'section', id: 's2' }, kind: 'repeats', origin: 'proposed', at: NOW },
      { id: 'lk2', from: { type: 'section', id: 's3' }, to: { type: 'section', id: 's2' }, kind: 'rests_on', origin: 'confirmed', at: NOW },
    ]
    const batches = collectIssues(meta)
    expect(batches.map((b) => b.category)).toEqual(['suggestions', 'sections', 'links', 'stale'])
    expect(batches.find((b) => b.category === 'links')!.items.map((i) => i.id)).toEqual(['lk1'])
    expect(issueCount(batches)).toBe(4)
  })
})

describe('issuesInRange', () => {
  it('keeps only what bears on the text', async () => {
    const { issuesInRange } = await import('./article-issues.js')
    const { createArticleMeta } = await import('./article-model.js')
    const base = createArticleMeta('a', 'A')
    const sg = (id: string, start: number, end: number) => ({ id, span: { start, end, quote: 'q' }, replacement: 'r', reason: '', proposedBy: 'assistant' as const, state: 'pending' as const, createdAt: 'n' })
    const meta = { ...base, suggestions: [sg('x', 0, 10), sg('y', 50, 60)] }
    expect(issuesInRange(meta, { start: 5, end: 5 }).suggestions.map((s) => s.id)).toEqual(['x'])
    expect(issuesInRange(meta, { start: 40, end: 70 }).suggestions.map((s) => s.id)).toEqual(['y'])
  })
})
