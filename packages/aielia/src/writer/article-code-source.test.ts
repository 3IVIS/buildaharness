import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import { parseLineRange, parseRepoFileLink, sliceLines } from './article-sources.js'

const NOW = '2026-10-17T10:00:00.000Z'
const MD = '# Post\n\nThe cache holds 100 items.\n'
const llm = (impacts: unknown[] = []): ILLMClient => ({ callChatStructured: async () => ({ content: JSON.stringify({ impacts }) }) }) as unknown as ILLMClient
const FILE = ['a', 'b', 'c', 'd', 'e'].join('\n')

describe('line ranges and repository links', () => {
  it('reads the numbers of a range in the usual written forms', () => {
    expect(parseLineRange('40-60')).toEqual({ from: 40, to: 60 })
    expect(parseLineRange('L40-L60')).toEqual({ from: 40, to: 60 })
    expect(parseLineRange('lines 7 – 3')).toEqual({ from: 3, to: 7 })
    expect(parseLineRange('12')).toEqual({ from: 12, to: 12 })
    expect(parseLineRange('none')).toBeUndefined()
    expect(parseLineRange('1 2 3')).toBeUndefined()
    expect(sliceLines(FILE, { from: 2, to: 3 })).toBe('b\nc')
  })
  it('turns a GitHub file link into the raw address and the fragment lines; anything else is not one', () => {
    expect(parseRepoFileLink('https://github.com/o/r/blob/main/src/a.ts#L2-L3')).toEqual({ rawUrl: 'https://raw.githubusercontent.com/o/r/main/src/a.ts', path: 'src/a.ts', lines: { from: 2, to: 3 } })
    expect(parseRepoFileLink('https://raw.githubusercontent.com/o/r/main/a.ts')).toMatchObject({ rawUrl: 'https://raw.githubusercontent.com/o/r/main/a.ts', path: 'a.ts' })
    expect(parseRepoFileLink('https://github.com/o/r')).toBeUndefined()
    expect(parseRepoFileLink('https://example.com/o/r/blob/main/a.ts')).toBeUndefined()
    expect(parseRepoFileLink('http://github.com/o/r/blob/main/a.ts')).toBeUndefined()
  })
})

describe('a repository file as a source', () => {
  it('is stored as code, fetched from the raw address, and keeps only the linked lines', async () => {
    const calls: string[] = []
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async (u) => { calls.push(u); return FILE } })
    const id = await svc.create('Post', MD)
    const sid = await svc.addSource(id, { kind: 'web', address: 'https://github.com/o/r/blob/main/a.ts#L2-L3' })
    expect((await svc.readSource(id, sid)).status).toBe('read')
    expect(calls).toEqual(['https://raw.githubusercontent.com/o/r/main/a.ts'])
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ kind: 'code', passage: 'b\nc', lines: { from: 2, to: 3 } })
  })
  it('a change outside the kept lines is not a change; one inside is held for the writer', async () => {
    let page = FILE
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async () => page })
    const id = await svc.create('Post', MD)
    const sid = await svc.addSource(id, { kind: 'web', address: 'https://github.com/o/r/blob/main/a.ts#L2-L3' })
    await svc.readSource(id, sid)
    page = 'A\nb\nc\nd\nE'
    expect((await svc.readSource(id, sid)).status).toBe('unchanged')
    page = 'a\nb\nCHANGED\nd\ne'
    expect((await svc.readSource(id, sid)).status).toBe('changed')
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'b\nc', fetchedPassage: 'b\nCHANGED', freshness: 'changed' })
    expect(await svc.acceptSourceChange(id, sid)).toEqual({ ok: true })
    expect((await svc.get(id)).meta.sources[0].passage).toBe('b\nCHANGED')
  })
  it('is included when sources are read again before publishing', async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async () => FILE })
    const id = await svc.create('Post', MD)
    await svc.addSource(id, { kind: 'web', address: 'https://github.com/o/r/blob/main/a.ts' })
    expect(await svc.recheckSources(id)).toMatchObject({ read: 1 })
  })
})

describe('line ranges on a stored source', () => {
  const build = async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW })
    const id = await svc.create('Post', MD)
    const sid = await svc.addSource(id, { kind: 'code', address: 'a.ts', passage: FILE })
    return { svc, id, sid }
  }
  it('narrows a dropped file from its stored text, and cannot widen it without the file', async () => {
    const { svc, id, sid } = await build()
    expect(await svc.setSourceLines(id, sid, { from: 2, to: 3 })).toEqual({ ok: true })
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'b\nc', lines: { from: 2, to: 3 } })
    expect(await svc.setSourceLines(id, sid, { from: 1, to: 5 })).toMatchObject({ ok: false })
    expect(await svc.setSourceLines(id, sid, { from: 90, to: 99 })).toMatchObject({ ok: false })
  })
  it('a source with an address takes any lines by reading it again', async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async () => FILE })
    const id = await svc.create('Post', MD)
    const sid = await svc.addSource(id, { kind: 'web', address: 'https://github.com/o/r/blob/main/a.ts#L2-L3' })
    await svc.readSource(id, sid)
    expect(await svc.setSourceLines(id, sid, { from: 1, to: 5 })).toEqual({ ok: true })
    expect((await svc.get(id)).meta.sources[0].passage).toBe(FILE)
    expect(await svc.setSourceLines(id, sid, undefined)).toEqual({ ok: true })
    expect((await svc.get(id)).meta.sources[0].lines).toBeUndefined()
  })
})

describe('a new version of a dropped file', () => {
  it('matches the stored file by name; the same text is unchanged, different text waits for the writer and marks citing claims', async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([{ claimId: 'c1', impact: 'likely_wrong', reason: 'limit is now 50' }]), now: () => NOW })
    const id = await svc.create('Post', MD)
    const sid = await svc.addSource(id, { kind: 'code', address: 'cache.ts', passage: 'const LIMIT = 100' })
    expect(await svc.offerFileVersion(id, 'other.ts', 'x')).toMatchObject({ status: 'no_match' })
    expect(await svc.offerFileVersion(id, 'cache.ts', 'const LIMIT = 100')).toMatchObject({ status: 'unchanged', sourceId: sid })
    const r = await svc.offerFileVersion(id, 'cache.ts', 'const LIMIT = 50')
    expect(r).toMatchObject({ status: 'changed', sourceId: sid })
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'const LIMIT = 100', fetchedPassage: 'const LIMIT = 50', freshness: 'changed' })
  })
  it('keeps only the stored lines of the new version', async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.addSource(id, { kind: 'code', address: 'a.ts', passage: FILE, lines: { from: 2, to: 3 } })
    expect(await svc.offerFileVersion(id, 'a.ts', 'X\nb\nc\nY')).toMatchObject({ status: 'unchanged' })
  })
})

describe('pulling a page in to edit', () => {
  const PAGE = 'Caching in practice\r\n\r\n\r\n\r\nThe cache holds 100 items.   \r\nIt is quick.\r\n'
  it('makes a new article from the page text with the page kept as its origin', async () => {
    const calls: string[] = []
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async (u) => { calls.push(u); return PAGE } })
    const r = await svc.importPage(' https://example.com/post ')
    if (!r.ok) throw new Error(r.reason)
    const b = await svc.get(r.id)
    expect(calls).toEqual(['https://example.com/post'])
    expect(b.markdown).toBe('Caching in practice\n\nThe cache holds 100 items.\nIt is quick.\n')
    expect(b.meta.name).toBe('Caching in practice')
    expect(b.meta.sources[0]).toMatchObject({ kind: 'web', address: 'https://example.com/post', note: 'The page this article was imported from.' })
    expect(b.meta.claims).toEqual([])
  })
  it('reads a GitHub markdown file from its raw address, and says why when it cannot import', async () => {
    const calls: string[] = []
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), now: () => NOW, fetchWeb: async (u) => { calls.push(u); return '# Notes\n\nHello.\n' } })
    const r = await svc.importPage('https://github.com/o/r/blob/main/NOTES.md')
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['https://raw.githubusercontent.com/o/r/main/NOTES.md'])
    expect(await svc.importPage('not a link')).toMatchObject({ ok: false })
    expect(await new ArticleService({ store: createMemoryArticleStore(), llm: llm() }).importPage('https://x.test')).toMatchObject({ ok: false })
    const down = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), fetchWeb: async () => { throw new Error('503') } })
    expect(await down.importPage('https://x.test')).toMatchObject({ ok: false, reason: expect.stringContaining('503') })
    const empty = new ArticleService({ store: createMemoryArticleStore(), llm: llm(), fetchWeb: async () => '  \n ' })
    expect(await empty.importPage('https://x.test')).toMatchObject({ ok: false })
  })
})
