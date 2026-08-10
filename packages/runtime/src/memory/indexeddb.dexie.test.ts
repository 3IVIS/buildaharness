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

  it('search returns a graduated, correctly-ranked result for a multi-term non-exact-substring query', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'dexie-search-graduated' })
    await adapter.set('reordered', 'appointment for the dentist')
    await adapter.set('partial', 'dentist visit only')
    await adapter.set('unrelated', 'completely different topic')

    const results = await adapter.search('dentist appointment', 5, 0.0)

    const reordered = results.find(r => r.key === 'reordered')
    const partial = results.find(r => r.key === 'partial')
    expect(reordered).toBeDefined()
    expect(partial).toBeDefined()
    // words present but not as the literal query substring → graduated score below 1.0
    expect(reordered?.score).toBeGreaterThan(0)
    expect(reordered?.score).toBeLessThan(1.0)
    // more matching terms ranks above fewer
    expect(reordered!.score).toBeGreaterThan(partial!.score)
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

  it('the version(1)→version(2) no-op upgrade preserves data written under version 1', async () => {
    // Simulates an existing user's pre-upgrade database: write directly against a
    // version-1-only Dexie instance (mirrors what MemoryDB looked like before the
    // passthrough bump), close it, then reopen through today's IndexedDBAdapter
    // (which declares both version(1) and version(2)) and confirm the old row survives
    // the upgrade untouched — this is the regression Phase 0 exists to prevent.
    const Dexie = (await import('dexie')).default
    const namespace = 'dexie-upgrade-chain'
    const v1db = new Dexie(`buildaharness-memory-${namespace}`)
    v1db.version(1).stores({ entries: 'key' })
    await v1db.open()
    await v1db.table('entries').put({ key: 'pre-upgrade', value: 'written under version 1' })
    v1db.close()

    const adapter = new IndexedDBAdapter({ namespace })
    expect(await adapter.get('pre-upgrade')).toBe('written under version 1')

    // And the upgrade chain itself still accepts new writes afterward.
    await adapter.set('post-upgrade', 'written under version 2')
    expect(await adapter.get('post-upgrade')).toBe('written under version 2')
  })

  it('a namespace with no prior database initializes directly at the current version', async () => {
    const adapter = new IndexedDBAdapter({ namespace: 'dexie-fresh-install' })
    await adapter.set('key', 'value')
    expect(await adapter.get('key')).toBe('value')
  })
})
