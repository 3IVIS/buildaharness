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
})
