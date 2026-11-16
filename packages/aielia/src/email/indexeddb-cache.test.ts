import { describe, it, expect } from 'vitest'
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb'
import { IndexedDbEmailCache, invertForSort } from './indexeddb-cache.js'
import { CACHE_CONFORMANCE_CHECKS, conformanceMessage } from './cache-conformance.js'

// The cache uses the IDBKeyRange global (the browser has it); in Node it comes from fake-indexeddb.
;(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = FakeKeyRange

let n = 0
const make = () => IndexedDbEmailCache.open(new IDBFactory(), `email-cache-test-${n++}`)

describe('IndexedDbEmailCache conformance', () => {
  for (const check of CACHE_CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      await check.run(make)
    }, 60_000)
  }
})

describe('IndexedDbEmailCache specifics', () => {
  it('invertForSort reverses order, including prefixes', () => {
    const xs = ['2026-01-01', '2026-01-02', '2026-01-02T10', 'b']
    const sorted = [...xs].sort((a, b) => (invertForSort(a) < invertForSort(b) ? -1 : 1))
    expect(sorted).toEqual([...xs].sort().reverse())
  })
  it('persists across reopen of the same database and keeps indexes in step with upserts', async () => {
    const factory = new IDBFactory()
    const a = await IndexedDbEmailCache.open(factory, 'persist')
    await a.upsertMessages([conformanceMessage(1), conformanceMessage(2, { folderIds: ['archive'] })])
    await a.setSyncToken('acct-c', 'v1')
    a.close()
    const b = await IndexedDbEmailCache.open(factory, 'persist')
    expect((await b.queryMessages({ folderId: 'archive' }, { offset: 0, limit: 10 })).items.map((m) => m.id)).toEqual(['m000002'])
    expect(await b.getSyncToken('acct-c')).toBe('v1')
    await b.upsertMessages([conformanceMessage(2, { folderIds: ['inbox'] })])
    expect((await b.queryMessages({ folderId: 'archive' }, { offset: 0, limit: 10 })).total).toBe(0)
    expect(await b.getMessage('m000002')).not.toHaveProperty('_all')
  })
})
