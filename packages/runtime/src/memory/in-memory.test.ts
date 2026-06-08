import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from './in-memory'

describe('InMemoryAdapter', () => {
  it('get/set/delete round-trip preserves exact value', async () => {
    const adapter = new InMemoryAdapter()
    const value = { nested: { num: 42, arr: [1, 2, 3] } }
    await adapter.set('mykey', value)
    expect(await adapter.get('mykey')).toEqual(value)
    await adapter.delete('mykey')
    expect(await adapter.get('mykey')).toBeUndefined()
  })

  it('get on missing key returns undefined without throwing', async () => {
    const adapter = new InMemoryAdapter()
    const result = await adapter.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('search linear scan returns top_k results sorted by descending score', async () => {
    const adapter = new InMemoryAdapter({ namespace: 'search-test' })
    await adapter.set('doc1', 'hello world')
    await adapter.set('doc2', 'goodbye world')
    await adapter.set('doc3', 'no match here')
    // Search for "hello" — only doc1 matches (score 1.0), doc3 scores 0
    const results = await adapter.search('hello', 5, 0.0)
    // doc1 and doc2 contain 'hello world' — only doc1 has 'hello'
    const doc1 = results.find(r => r.key === 'doc1')
    expect(doc1).toBeDefined()
    expect(doc1?.score).toBe(1.0)
    // Results sorted by descending score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('results below min_score are excluded from search output', async () => {
    const adapter = new InMemoryAdapter({ namespace: 'min-score-test' })
    await adapter.set('match', 'contains the query term')
    await adapter.set('nomatch', 'irrelevant content')
    // With minScore=1.0, only exact-match entries (score=1.0) should appear
    const results = await adapter.search('query', 5, 1.0)
    expect(results.every(r => r.score >= 1.0)).toBe(true)
    expect(results.some(r => r.key === 'match')).toBe(true)
    // 'nomatch' has score 0.0 → filtered out
    expect(results.some(r => r.key === 'nomatch')).toBe(false)
  })

  it('global scope and thread scope use separate key namespaces — no cross-contamination', async () => {
    const globalAdapter = new InMemoryAdapter({ scope: 'global', namespace: 'ns1' })
    const threadAdapter = new InMemoryAdapter({ scope: 'thread', instanceId: 'thread-1', namespace: 'ns1' })

    await globalAdapter.set('shared-key', 'global-value')
    await threadAdapter.set('shared-key', 'thread-value')

    // Each adapter sees only its own value
    expect(await globalAdapter.get('shared-key')).toBe('global-value')
    expect(await threadAdapter.get('shared-key')).toBe('thread-value')
  })

  it('set with mode="append" implements array-push semantics', async () => {
    const adapter = new InMemoryAdapter()
    // Empty → wraps in array
    await adapter.set('list', 'first', 'append')
    expect(await adapter.get('list')).toEqual(['first'])
    // Array → concat
    await adapter.set('list', 'second', 'append')
    expect(await adapter.get('list')).toEqual(['first', 'second'])
    // Scalar → wraps both in array
    await adapter.set('scalar', 42)
    await adapter.set('scalar', 99, 'append')
    expect(await adapter.get('scalar')).toEqual([42, 99])
  })

  it('set with mode="overwrite" replaces existing value', async () => {
    const adapter = new InMemoryAdapter()
    await adapter.set('key', 'original', 'upsert')
    await adapter.set('key', 'replaced', 'overwrite')
    expect(await adapter.get('key')).toBe('replaced')
  })

  it('search respects top_k limit', async () => {
    const adapter = new InMemoryAdapter({ namespace: 'topk-test' })
    for (let i = 0; i < 10; i++) {
      await adapter.set(`doc${i}`, `item contains keyword ${i}`)
    }
    const results = await adapter.search('keyword', 3, 0.0)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
