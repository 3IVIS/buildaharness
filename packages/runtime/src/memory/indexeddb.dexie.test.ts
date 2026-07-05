import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { IndexedDBAdapter } from './indexeddb'

// Polyfills globalThis.indexedDB so these tests exercise the real Dexie-backed
// path instead of the in-memory fallback (see indexeddb.test.ts for that path).

describe('IndexedDBAdapter (real IndexedDB via fake-indexeddb)', () => {
  it('value persisted by one adapter instance is readable by a second instance with the same namespace', async () => {
    const adapter1 = new IndexedDBAdapter({ namespace: 'dexie-shared' })
    const adapter2 = new IndexedDBAdapter({ namespace: 'dexie-shared' })

    await adapter1.set('key1', 'hello from adapter1')
    expect(await adapter2.get('key1')).toBe('hello from adapter1')
  })

  it('append mode accumulates values into an array', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'dexie-append' })
    await adapter.set('transcript', { role: 'user', content: 'hi' }, 'append')
    await adapter.set('transcript', { role: 'assistant', content: 'hello' }, 'append')

    expect(await adapter.get('transcript')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('search does a linear scan over stored entries', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'dexie-search' })
    await adapter.set('docA', 'the quick brown fox')
    await adapter.set('docB', 'lazy dog')

    const results = await adapter.search('quick', 5, 0.0)
    const docA = results.find(r => r.key === 'docA')
    expect(docA?.score).toBe(1.0)
  })

  it('delete removes a key', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'dexie-delete' })
    await adapter.set('toDelete', 'value')
    await adapter.delete('toDelete')
    expect(await adapter.get('toDelete')).toBeUndefined()
  })

  it('different namespaces use isolated databases', async () => {
    const adapterA = new IndexedDBAdapter({ namespace: 'dexie-ns-a' })
    const adapterB = new IndexedDBAdapter({ namespace: 'dexie-ns-b' })
    await adapterA.set('key', 'from-a')
    expect(await adapterB.get('key')).toBeUndefined()
  })
})
