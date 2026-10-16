import { describe, it, expect } from 'vitest'
import { createArticleMeta, type ArticleMeta, type Claim } from './article-model.js'
import { createSnapshot } from './article-rules.js'
import { createSource } from './article-sources.js'
import { addSnapshot, compareVersions, diffLines, isLargeChange, MAX_CHECKPOINTS, summarizeChange } from './article-history.js'

const NOW = '2026-10-16T10:00:00.000Z'
const claim = (over: Partial<Claim>): Claim => ({ id: 'k1', sectionId: 's1', quote: 'It is fast.', position: 0, kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'none', ...over })
const meta = (over: Partial<ArticleMeta> = {}): ArticleMeta => ({ ...createArticleMeta('a1', 'T'), ...over })

describe('diffLines', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' },
    ])
    expect(diffLines('', 'x')).toEqual([{ type: 'add', text: 'x' }])
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }])
    expect(diffLines('same', 'same').every((l) => l.type === 'same')).toBe(true)
  })
})

describe('compareVersions', () => {
  it('reports the text, claims whose shown status changed, sources that changed, and the readiness counts', () => {
    const src = createSource({ id: 'src1', kind: 'upload', passage: '18 ms', now: NOW })
    const checked = claim({ sourceStatus: 'supported', check: { ranAt: NOW, model: 'm', reason: 'ok', claimText: 'It is fast.', sourceFingerprints: { src1: src.fingerprint! } } })
    const from = { markdown: 'It is fast.\n', meta: meta({ claims: [checked], sources: [src] }) }
    const changedSrc = createSource({ id: 'src1', kind: 'upload', passage: '41 ms', now: NOW })
    const to = { markdown: 'It is fast.\nMore.\n', meta: meta({ claims: [checked, claim({ id: 'k2', quote: 'New claim.' })], sources: [changedSrc, createSource({ id: 'src2', kind: 'say_so', note: 'n', now: NOW })] }) }
    const r = compareVersions(from, to)
    expect(r.changedLines).toBeGreaterThan(0)
    expect(r.claims).toEqual(expect.arrayContaining([{ quote: 'It is fast.', from: 'supported', to: 'stale' }, { quote: 'New claim.', from: 'absent', to: 'none' }]))
    expect(r.sources).toEqual(expect.arrayContaining([{ id: 'src1', address: undefined, change: 'changed' }, { id: 'src2', address: undefined, change: 'added' }]))
    expect(r.readiness.to.unsourcedFactualClaims).toBe(1)
  })
  it('finds nothing when nothing changed', () => {
    const v = { markdown: 'x', meta: meta() }
    const r = compareVersions(v, v)
    expect(r).toMatchObject({ changedLines: 0, claims: [], sources: [] })
  })
})

describe('snapshots list', () => {
  const snap = (kind: 'published' | 'checkpoint', n: number) => createSnapshot(kind, `v${n}`, meta(), NOW, `v${n}`)
  it('keeps every published version and only the newest checkpoints', () => {
    let list: ReturnType<typeof addSnapshot> = []
    list = addSnapshot(list, snap('published', 0))
    for (let i = 1; i <= MAX_CHECKPOINTS + 3; i++) list = addSnapshot(list, snap('checkpoint', i))
    expect(list.filter((s) => s.kind === 'published')).toHaveLength(1)
    const cps = list.filter((s) => s.kind === 'checkpoint')
    expect(cps).toHaveLength(MAX_CHECKPOINTS)
    expect(cps[0].label).toBe('v4')
    expect(cps.at(-1)?.label).toBe(`v${MAX_CHECKPOINTS + 3}`)
  })
})

describe('isLargeChange', () => {
  it('flags a rewrite but not a small edit', () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(isLargeChange(base, base.replace('line 3', 'line three'))).toBe(false)
    expect(isLargeChange(base, Array.from({ length: 20 }, (_, i) => `other ${i}`).join('\n'))).toBe(true)
    expect(isLargeChange('a\nb', 'a\nc')).toBe(false)
  })
})

describe('summarizeChange', () => {
  const side = (markdown: string, sections: { heading: string; start: number; end: number }[]) => ({
    markdown,
    meta: meta({ sections: sections.map((s, i) => ({ id: `s${i}`, heading: s.heading, level: 2, order: i, span: { start: s.start, end: s.end }, review: { state: 'clean' as const } })) }),
  })
  const A = '## One\nalpha\n## Two\nbeta\n'
  const aSections = [{ heading: 'One', start: 0, end: 12 }, { heading: 'Two', start: 12, end: A.length }]
  it('names the sections that changed and counts the lines', () => {
    const B = '## One\nalpha\n## Two\nbeta changed\nmore\n'
    const bSections = [{ heading: 'One', start: 0, end: 12 }, { heading: 'Two', start: 12, end: B.length }]
    const r = summarizeChange(side(A, aSections), side(B, bSections))
    expect(r).toMatchObject({ first: false, added: 2, removed: 1, sections: ['Two'], claims: 0, sources: 0 })
  })
  it('counts added and removed sections, and says first when nothing came before', () => {
    const C = '## One\nalpha\n## Three\ngamma\n'
    const cSections = [{ heading: 'One', start: 0, end: 12 }, { heading: 'Three', start: 12, end: C.length }]
    expect(summarizeChange(side(A, aSections), side(C, cSections)).sections.sort()).toEqual(['Three', 'Two'])
    expect(summarizeChange(undefined, side(A, aSections))).toMatchObject({ first: true, added: 5, removed: 0 })
  })
})
