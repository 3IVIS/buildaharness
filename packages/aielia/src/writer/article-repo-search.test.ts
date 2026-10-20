import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import { githubRepoReader, type RepoReader } from './repo-reader.js'

const NOW = '2026-10-19T10:00:00.000Z'
const MD = '# Post\n\nWrite waits 800 milliseconds before saving.\n\nThe cache holds 100 items.\n'
const FILES: Record<string, string> = { 'src/save.ts': 'export const SAVE_DELAY_MS = 800\n', 'src/other.ts': 'export const x = 1\n' }
const reader: RepoReader = { name: 'repo', files: async () => Object.keys(FILES), read: async (p) => FILES[p], addressOf: (p) => `https://example.test/${p}` }

/** Answers claim extraction, then plays a script for the repository search. */
function llm(script: LLMStructuredResponse[]): ILLMClient {
  return {
    callChatStructured: async (m: ChatMessage[]) => {
      const system = m[0].content
      if (system.startsWith('You read parts of an article and list the claims')) {
        return { content: JSON.stringify({ claims: [{ quote: 'Write waits 800 milliseconds before saving.', kind: 'factual' }, { quote: 'The cache holds 100 items.', kind: 'factual' }] }) }
      }
      const r = script.shift()
      if (!r) throw new Error('script ran out: ' + system.slice(0, 60))
      return r
    },
  } as unknown as ILLMClient
}

describe('verifying claims by letting the model search the repository', () => {
  it('keeps the checked lines as code sources with a recorded verdict, and leaves a claim it could not settle looked-for', async () => {
    const rows = [
      { id: 'k1', verdict: 'supported', reason: 'The delay is 800 ms.', evidence: [{ file: 'src/save.ts', excerpt: 'SAVE_DELAY_MS = 800' }] },
      { id: 'k2', verdict: 'not_supported', reason: 'Nothing about a cache.', searched: ['cache'] },
    ]
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([{ content: '', toolCalls: [{ id: 't', name: 'search', input: { pattern: 'DELAY' } }] }, { content: JSON.stringify(rows) }]), now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, reader)
    const report = await svc.verifyClaims(id, { repoOnly: true })
    expect(report.entries.map((e) => [e.claimId, e.outcome])).toEqual([['k1', 'supported'], ['k2', 'no_source_found']])
    expect(report.entries[0].found).toEqual(['https://example.test/src/save.ts'])
    const meta = (await svc.get(id)).meta
    expect(meta.claims.find((c) => c.id === 'k1')).toMatchObject({ sourceStatus: 'supported', check: { reason: 'The delay is 800 ms.' } })
    expect(meta.sources).toHaveLength(1)
    expect(meta.sources[0]).toMatchObject({ kind: 'code', address: 'https://example.test/src/save.ts' })
    expect(meta.sources[0].passage).toContain('SAVE_DELAY_MS = 800')
    expect(meta.claims.find((c) => c.id === 'k2')?.lookup).toMatchObject({ outcome: 'no_results', tried: ['cache'] })
  })
  it('rejects a verdict whose quote is not in the file instead of storing it', async () => {
    const bad = [{ id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/save.ts', excerpt: 'SAVE_DELAY_MS = 900' }] }, { id: 'k2', verdict: 'not_supported', reason: 'none', searched: ['x'] }]
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([{ content: JSON.stringify(bad) }, { content: JSON.stringify([{ id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'src/other.ts', excerpt: 'bogus words not there' }] }]) }]), now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, reader)
    const report = await svc.verifyClaims(id, { repoOnly: true })
    expect(report.entries[0]).toMatchObject({ claimId: 'k1', outcome: 'could_not_check' })
    expect((await svc.get(id)).meta.sources).toHaveLength(0)
  })

  const LOOKUP: LLMStructuredResponse = { content: '', toolCalls: [{ id: 't', name: 'search', input: { pattern: 'DELAY' } }] }
  const rows = [{ id: 'k1', verdict: 'supported', reason: 'The delay is 800 ms.', evidence: [{ file: 'src/save.ts', excerpt: 'SAVE_DELAY_MS = 800' }] }, { id: 'k2', verdict: 'not_supported', reason: 'Nothing.', searched: ['cache'] }]

  it('is the default: no strategy given searches the repository', async () => {
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([LOOKUP, { content: JSON.stringify(rows) }]), now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, reader)
    const report = await svc.verifyClaims(id, { repoOnly: true })
    expect(report.entries.map((e) => e.outcome)).toEqual(['supported', 'no_source_found'])
  })

  it('searches two repositories as one, each file under its repository name', async () => {
    const second: RepoReader = { name: 'second', files: async () => ['lib/cache.ts'], read: async () => 'export const CACHE_ITEMS = 100\n', addressOf: (p) => `https://example.test/second/${p}` }
    const both = [{ id: 'k1', verdict: 'supported', reason: 'r', evidence: [{ file: 'repo/src/save.ts', excerpt: 'SAVE_DELAY_MS = 800' }] }, { id: 'k2', verdict: 'supported', reason: 'r', evidence: [{ file: 'second/lib/cache.ts', excerpt: 'CACHE_ITEMS = 100' }] }]
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([LOOKUP, { content: JSON.stringify(both) }]), now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, reader)
    svc.attachRepo(id, second)
    const report = await svc.verifyClaims(id, { repoOnly: true })
    expect(report.entries.map((e) => e.found)).toEqual([['https://example.test/src/save.ts'], ['https://example.test/second/lib/cache.ts']])
  })

  it('sends a claim the repository does not settle to the web, unless repository only is asked for', async () => {
    const searched: string[] = []
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: llm([LOOKUP, { content: JSON.stringify(rows) }, LOOKUP, { content: JSON.stringify(rows) }]), now: () => NOW, searchWeb: async (q) => { searched.push(q); return [] }, fetchWeb: async () => 'x' })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, reader)
    await svc.verifyClaims(id, { repoOnly: true })
    expect(searched).toEqual([])
    await svc.verifyClaims(id)
    expect(searched.length).toBeGreaterThan(0)
  })

  it('searches a GitHub repository: the file list and files come through the reader once, with the cache marker on every model call', async () => {
    const requests: string[] = []
    const fetchImpl = (async (url: string) => {
      requests.push(url)
      if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'src/save.ts', type: 'blob', size: 40 }, { path: 'src/other.ts', type: 'blob', size: 20 }] }))
      const path = url.split('/main/')[1] ?? url.split('/HEAD/')[1]
      return FILES[path] === undefined ? new Response('', { status: 404 }) : new Response(FILES[path])
    }) as unknown as typeof fetch
    const options: unknown[] = []
    const model = llm([LOOKUP, { content: JSON.stringify(rows) }])
    const wrapped = { callChatStructured: async (m: ChatMessage[], t?: unknown, o?: unknown) => { options.push(o); return model.callChatStructured(m, t as never, o as never) } } as unknown as ILLMClient
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm: wrapped, now: () => NOW })
    const id = await svc.create('Post', MD)
    await svc.analyze(id)
    svc.attachRepo(id, githubRepoReader({ owner: 'o', repo: 'r' }, { fetchImpl }))
    const report = await svc.verifyClaims(id)
    expect(report.entries[0]).toMatchObject({ outcome: 'supported', found: ['https://github.com/o/r/blob/HEAD/src/save.ts'] })
    expect(requests.filter((r) => r.includes('/git/trees/'))).toHaveLength(1)
    expect(options.some((o) => (o as { cachePrompt?: boolean } | undefined)?.cachePrompt === true)).toBe(true)
  })
})
