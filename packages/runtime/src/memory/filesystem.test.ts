import { describe, it, expect } from 'vitest'
import { FileSystemAdapter } from './filesystem'
import type { FsBackend } from './fs-backend'

/** A fake FsBackend over an in-memory Map, standing in for a real disk across tests. */
function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {
      // Fake backend has no real directories to create.
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length))
        }
      }
      return names
    },
  }
}

describe('FileSystemAdapter', () => {
  it('set/get round-trips a value', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    await adapter.set('greeting', 'hello')
    expect(await adapter.get('greeting')).toBe('hello')
  })

  it('get returns undefined for a key that was never set', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    expect(await adapter.get('missing')).toBeUndefined()
  })

  it('append mode accumulates values into an array', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    await adapter.set('log', 'first', 'append')
    await adapter.set('log', 'second', 'append')
    expect(await adapter.get('log')).toEqual(['first', 'second'])
  })

  it('delete removes the value', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    await adapter.set('toDelete', 'value')
    await adapter.delete('toDelete')
    expect(await adapter.get('toDelete')).toBeUndefined()
  })

  it('search scans every file in the namespace and reports the original (unsanitized) key', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    await adapter.set('transcript:session-a', 'the quick brown fox')
    await adapter.set('transcript:session-b', 'lazy dog')

    const results = await adapter.search('quick', 5, 0.0)
    const match = results.find(r => r.key === 'transcript:session-a')
    expect(match?.score).toBe(1.0)
  })

  it('different namespaces under the same baseDir are isolated', async () => {
    const backend = makeFakeBackend()
    const adapterA = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'ns-a' })
    const adapterB = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'ns-b' })
    await adapterA.set('key', 'from-a')
    expect(await adapterB.get('key')).toBeUndefined()
  })

  it('a second adapter sharing the same backend and baseDir sees values persisted by the first (simulates a restart)', async () => {
    const backend = makeFakeBackend()
    const first = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'shared' })
    await first.set('key1', 'hello from first')

    const second = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'shared' })
    expect(await second.get('key1')).toBe('hello from first')
  })

  // T5 (memory-transparency-search plan): scoreEntries() itself already has direct coverage in
  // scoring.test.ts — this proves FileSystemAdapter.search() actually delegates to it end-to-end,
  // not just that the shared function works in isolation.
  it('search returns a graduated, correctly-ranked result for a multi-term non-exact-substring query', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    await adapter.set('reordered', 'appointment for the dentist')
    await adapter.set('partial', 'dentist visit only')
    await adapter.set('unrelated', 'completely different topic')

    const results = await adapter.search('dentist appointment', 5, 0.0)

    const reordered = results.find(r => r.key === 'reordered')
    const partial = results.find(r => r.key === 'partial')
    expect(reordered).toBeDefined()
    expect(partial).toBeDefined()
    // words present but not as the literal query substring → graduated score below 1.0
    expect(reordered!.score).toBeGreaterThan(0)
    expect(reordered!.score).toBeLessThan(1.0)
    // more matching terms ranks above fewer
    expect(reordered!.score).toBeGreaterThan(partial!.score)
  })

  // T2 step 5 / the memory-transparency-search plan's own known-limitations note: search() is a
  // linear scan over every stored entry, not an inverted index — O(total lifetime message count),
  // not O(matches). This documents that ceiling as an explicit, tested bound (a personal-use
  // install's realistic upper range) rather than letting it surface later as an unexplained
  // slowdown; it's an early warning for a future change that makes scoring materially more
  // expensive, not a performance guarantee for arbitrary scale.
  it('search over a few thousand synthetic entries completes within a documented time bound', async () => {
    const adapter = new FileSystemAdapter({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'bench' })
    for (let i = 0; i < 3000; i++) {
      await adapter.set(`transcript-msg:session-${i % 20}:${i}`, {
        sessionId: `session-${i % 20}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message number ${i} about something ordinary`,
        at: new Date(i).toISOString(),
      })
    }

    const start = Date.now()
    const results = await adapter.search('dentist appointment', 10, 0.1)
    const elapsedMs = Date.now() - start

    expect(results).toEqual([])
    expect(elapsedMs).toBeLessThan(2000)
  })
})
