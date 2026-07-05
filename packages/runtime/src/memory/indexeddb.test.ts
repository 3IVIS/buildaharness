import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IndexedDBAdapter, _fallbackStores } from './indexeddb'

// In Node.js test environment, IndexedDB is never available → all tests exercise the fallback path.

describe('IndexedDBAdapter (node env — fallback path)', () => {
  beforeEach(() => {
    // Clear shared fallback stores between tests to prevent cross-test contamination
    _fallbackStores.clear()
  })

  it('value persisted by one adapter instance is readable by a second instance with the same namespace', async () => {
    const adapter1 = new IndexedDBAdapter({ namespace: 'shared-ns' })
    const adapter2 = new IndexedDBAdapter({ namespace: 'shared-ns' })

    await adapter1.set('key1', 'hello from adapter1')
    const result = await adapter2.get('key1')
    expect(result).toBe('hello from adapter1')
  })

  it('falls back to in-memory store silently when IndexedDB is unavailable (always true in Node)', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'fallback-test' })
    await adapter.set('foo', 'bar')
    expect(await adapter.get('foo')).toBe('bar')
  })

  it('logs console.warn on unavailability when IndexedDB is absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // In Node env, IDB is always unavailable, so warn is always emitted
      new IndexedDBAdapter({ namespace: 'warn-test' })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('IndexedDBAdapter: IndexedDB not available'),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('search does a linear scan on fallback Map', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'search-fallback' })
    await adapter.set('docA', 'the quick brown fox')
    await adapter.set('docB', 'lazy dog')
    await adapter.set('docC', 'quick lazy fox')

    const results = await adapter.search('quick', 5, 0.0)
    expect(results.some(r => r.key === 'docA')).toBe(true)
    expect(results.some(r => r.key === 'docC')).toBe(true)
    // 'lazy dog' doesn't contain 'quick' → score 0, but minScore=0 so may or may not appear
    // Just verify docA and docC have score 1.0
    const docA = results.find(r => r.key === 'docA')
    expect(docA?.score).toBe(1.0)
  })

  it('delete removes a key from the fallback store', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'delete-test' })
    await adapter.set('toDelete', 'value')
    await adapter.delete('toDelete')
    expect(await adapter.get('toDelete')).toBeUndefined()
  })

  it('different namespaces are isolated — no cross-namespace contamination', async () => {
    const adapterA = new IndexedDBAdapter({ namespace: 'ns-a' })
    const adapterB = new IndexedDBAdapter({ namespace: 'ns-b' })
    await adapterA.set('key', 'from-a')
    expect(await adapterB.get('key')).toBeUndefined()
  })
})
