import { describe, it, expect } from 'vitest'
import { createArticleMeta, ARTICLE_META_VERSION } from './article-model.js'
import { createSnapshot } from './article-rules.js'
import { loadArticleFolder, serializeArticle, type ArticleBundle } from './article-folder.js'
import { acceptNewPassage, applyRecheck, createSource, fingerprintPassage } from './article-sources.js'

const NOW = '2026-10-16T10:00:00.000Z'

function bundle(): ArticleBundle {
  const meta = { ...createArticleMeta('a1', 'Title'), sources: [createSource({ id: 'src1', kind: 'upload', address: 'bench.txt', passage: '120,000 requests/s', now: NOW }), createSource({ id: 'src2', kind: 'say_so', note: 'writer re-ran it', now: NOW })] }
  return { markdown: '# Title\n\nIt is fast.\n', meta, snapshots: [createSnapshot('published', '# Title\n', meta, NOW, 'v1')] }
}

describe('fingerprints and rechecks', () => {
  it('ignores whitespace, detects real change', () => {
    expect(fingerprintPassage('a  b\n c')).toBe(fingerprintPassage('a b c'))
    expect(fingerprintPassage('120,000')).not.toBe(fingerprintPassage('12,000'))
  })
  it('marks say-so sources lower-trust and sources without a passage unchecked', () => {
    const b = bundle().meta.sources
    expect(b[1]).toMatchObject({ trust: 'lower', freshness: 'unchecked' })
    expect(b[0]).toMatchObject({ trust: 'normal', freshness: 'current' })
  })
  it('keeps the stored passage when a recheck finds a change, until the writer accepts the new one', () => {
    const s = bundle().meta.sources[0]
    expect(applyRecheck(s, { passage: '120,000   requests/s' }, 'later')).toMatchObject({ freshness: 'current', readAt: 'later' })
    const changed = applyRecheck(s, { passage: '41,000 requests/s' }, 'later')
    expect(changed).toMatchObject({ freshness: 'changed', passage: '120,000 requests/s', fingerprint: s.fingerprint })
    expect(applyRecheck(s, { unreachable: true }, 'later').freshness).toBe('unreachable')
    const accepted = acceptNewPassage(changed, '41,000 requests/s', 'later')
    expect(accepted).toMatchObject({ freshness: 'current', passage: '41,000 requests/s' })
    expect(accepted.fingerprint).not.toBe(s.fingerprint)
  })
})

describe('article folder', () => {
  it('round-trips the text, the metadata, the passages and the snapshots, with passages kept out of the main file', () => {
    const b = bundle()
    const folder = serializeArticle(b)
    expect(Object.keys(folder).sort()).toEqual(['article.md', 'article.meta.json', 'sources/src1.txt', 'versions/0001.json'])
    expect(folder['article.meta.json']).not.toContain('120,000')
    expect(folder['sources/src1.txt']).toBe('120,000 requests/s')
    const r = loadArticleFolder(folder)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundle.markdown).toBe(b.markdown)
    expect(r.bundle.meta).toEqual(b.meta)
    expect(r.bundle.snapshots).toHaveLength(1)
    expect(r.bundle.snapshots[0]).toMatchObject({ kind: 'published', label: 'v1' })
  })

  it('refuses, with a reason, instead of loading partly', () => {
    const folder = serializeArticle(bundle())
    const without = (path: string) => Object.fromEntries(Object.entries(folder).filter(([p]) => p !== path))
    expect(loadArticleFolder(without('article.md'))).toMatchObject({ ok: false })
    expect(loadArticleFolder(without('article.meta.json'))).toMatchObject({ ok: false })
    const missing = loadArticleFolder(without('sources/src1.txt'))
    expect(missing).toMatchObject({ ok: false })
    expect((missing as { reason: string }).reason).toContain('sources/src1.txt')
    expect(loadArticleFolder({ ...folder, 'article.meta.json': '{nope' })).toMatchObject({ ok: false })
    expect(loadArticleFolder({ ...folder, 'versions/0001.json': '{}' })).toMatchObject({ ok: false })
    const newer = { ...JSON.parse(folder['article.meta.json']), formatVersion: ARTICLE_META_VERSION + 1 }
    const r = loadArticleFolder({ ...folder, 'article.meta.json': JSON.stringify(newer) })
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain('newer')
  })
})
