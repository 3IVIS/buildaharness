// Contract any `FactRepository` must pass. Imported by the test file for each implementation.
import { describe, it, expect } from 'vitest'
import { VersionConflictError, type FactRepository } from './fact-repository.js'

interface Row { id: string; text: string; status?: string }

export function runFactRepositoryContract(name: string, make: () => FactRepository): void {
  describe(`FactRepository contract: ${name}`, () => {
    it('round-trips a list and reports an absent key as empty', async () => {
      const repo = make()
      expect(await repo.list('facts')).toEqual([])
      await repo.put('facts', [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }])
      expect(await repo.list('facts')).toEqual([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }])
    })

    it('applies several changes as one commit and bumps the version once', async () => {
      const repo = make()
      const v0 = repo.version()
      const v1 = await repo.apply([{ key: 'x', value: [{ id: '1', text: 'x1' }] }, { key: 'y', value: [{ id: '2', text: 'y1' }] }])
      expect(v1).toBe(v0 + 1)
      expect(repo.version()).toBe(v1)
      expect(await repo.list('x')).toHaveLength(1)
      expect(await repo.list('y')).toHaveLength(1)
    })

    it('rejects a stale expected version and changes nothing', async () => {
      const repo = make()
      await repo.put('x', [{ id: '1', text: 'kept' }])
      const stale = repo.version() - 1
      await expect(repo.apply([{ key: 'x', value: [] }], stale)).rejects.toBeInstanceOf(VersionConflictError)
      expect(await repo.list('x')).toEqual([{ id: '1', text: 'kept' }])
      await expect(repo.apply([{ key: 'x', value: [] }], repo.version())).resolves.toBeGreaterThan(0)
    })

    it('distinguishes removing a list from storing an empty one', async () => {
      const repo = make()
      await repo.put('x', [])
      expect(await repo.list('x')).toEqual([])
      await repo.remove('x')
      expect(await repo.list('x')).toEqual([])
    })

    it('queries by predicate and by id', async () => {
      const repo = make()
      await repo.put('facts', [{ id: 'a', text: 'one', status: 'live' }, { id: 'b', text: 'two', status: 'retired' }])
      expect(await repo.list<Row>('facts', { where: (r) => r.status === 'live' })).toEqual([{ id: 'a', text: 'one', status: 'live' }])
      expect((await repo.get<Row>('facts', 'b', (r) => r.id))?.text).toBe('two')
      expect(await repo.get<Row>('facts', 'zzz', (r) => r.id)).toBeUndefined()
    })

    it('appends events in order and lets the caller bound the list', async () => {
      const repo = make()
      await repo.appendEvents('ev', [{ seq: 1 }, { seq: 2 }])
      await repo.appendEvents('ev', [{ seq: 3 }])
      expect((await repo.list<{ seq: number }>('ev')).map((e) => e.seq)).toEqual([1, 2, 3])
      const trimmed = await repo.appendEvents<{ seq: number }>('ev', [{ seq: 4 }], (all) => all.slice(-2))
      expect(trimmed.map((e) => e.seq)).toEqual([3, 4])
      expect((await repo.list<{ seq: number }>('ev')).map((e) => e.seq)).toEqual([3, 4])
    })

    it('stores text only where it was put: replacing a list with one that omits a fact withholds it', async () => {
      const repo = make()
      await repo.put('durable', [{ id: 'a', text: 'secret address' }])
      await repo.put('durable', [])
      expect(JSON.stringify(await repo.list('durable'))).not.toContain('secret address')
    })
  })
}
