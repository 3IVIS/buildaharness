import { InMemoryAdapter } from '@buildaharness/runtime'
import { KeyValueFactRepository, VersionConflictError, type FactChange, type FactQuery, type FactRepository } from './fact-repository.js'
import { runFactRepositoryContract } from './fact-repository.contract.js'
import { describe, it, expect } from 'vitest'

/** Independent fake: plain Map, no MemoryAdapter. A future adapter is checked against the same suite. */
class FakeFactRepository implements FactRepository {
  private ver = 0
  private readonly data = new Map<string, unknown[]>()
  version() { return this.ver }
  async list<T>(key: string, query?: FactQuery<T>): Promise<T[]> {
    const rows = [...((this.data.get(key) as T[] | undefined) ?? [])]
    return query?.where ? rows.filter(query.where) : rows
  }
  async get<T>(key: string, id: string, idOf: (row: T) => string) { return (await this.list<T>(key)).find((r) => idOf(r) === id) }
  async apply(changes: FactChange[], expectedVersion?: number) {
    if (expectedVersion !== undefined && expectedVersion !== this.ver) throw new VersionConflictError(expectedVersion, this.ver)
    for (const c of changes) { if (c.value === null) this.data.delete(c.key); else this.data.set(c.key, [...c.value]) }
    return ++this.ver
  }
  async put(key: string, value: unknown[]) { await this.apply([{ key, value }]) }
  async remove(key: string) { await this.apply([{ key, value: null }]) }
  async appendEvents<T>(key: string, events: T[], trim: (all: T[]) => T[] = (a) => a) {
    const next = trim([...(await this.list<T>(key)), ...events])
    await this.apply([{ key, value: next }])
    return next
  }
}

runFactRepositoryContract('KeyValueFactRepository', () => new KeyValueFactRepository(new InMemoryAdapter()))
runFactRepositoryContract('in-memory fake', () => new FakeFactRepository())

describe('KeyValueFactRepository specifics', () => {
  it('keeps the on-disk layout: a list is stored under its own key, absent after remove', async () => {
    const store = new InMemoryAdapter()
    const repo = new KeyValueFactRepository(store)
    await repo.put('memory:durable', [{ id: 'a' }])
    expect(await store.get('memory:durable')).toEqual([{ id: 'a' }])
    await repo.remove('memory:durable')
    expect(await store.get('memory:durable')).toBeUndefined()
  })

  it('rolls back earlier writes when a later one in the same commit fails', async () => {
    const store = new InMemoryAdapter()
    const repo = new KeyValueFactRepository(store)
    await repo.put('a', [{ id: 'old' }])
    const realSet = store.set.bind(store)
    store.set = async (k: string, v: unknown, m?: string) => { if (k === 'b') throw new Error('disk full'); return realSet(k, v, m) }
    await expect(repo.apply([{ key: 'a', value: [{ id: 'new' }] }, { key: 'b', value: [{ id: 'x' }] }])).rejects.toThrow('disk full')
    expect(await store.get('a')).toEqual([{ id: 'old' }])
  })
})
