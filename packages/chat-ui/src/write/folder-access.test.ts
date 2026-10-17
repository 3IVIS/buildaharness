import { describe, it, expect } from 'vitest'
import { pickFolder, readerFor } from './folder-access'

type Node = string | { [name: string]: Node }
function dir(name: string, tree: { [name: string]: Node }): never {
  const handle = {
    kind: 'directory' as const,
    name,
    async *entries() { for (const [n, v] of Object.entries(tree)) yield [n, typeof v === 'string' ? { kind: 'file' as const, getFile: async () => ({ text: async () => v }) } : dir(n, v)] },
    async getFileHandle(n: string) { const v = tree[n]; if (typeof v !== 'string') throw new Error('no file'); return { kind: 'file' as const, getFile: async () => ({ text: async () => v }) } },
    async getDirectoryHandle(n: string) { const v = tree[n]; if (typeof v === 'string' || !v) throw new Error('no dir'); return dir(n, v) },
  }
  return handle as never
}

describe('the browser folder reader', () => {
  const root = dir('repo', { 'a.ts': 'A', '.git': { config: 'x' }, node_modules: { 'p.js': 'x' }, lib: { 'b.py': 'B', 'pic.png': 'x' } })
  it('lists the readable files, skipping history and dependencies, and reads one by path', async () => {
    const r = readerFor(root)
    expect(r.name).toBe('repo')
    expect(await r.files()).toEqual(['a.ts', 'lib/b.py'])
    expect(await r.read('lib/b.py')).toBe('B')
    expect(await r.read('lib/missing.py')).toBeUndefined()
  })
  it('treats cancelling the picker as no folder, and other failures as errors', async () => {
    expect(await pickFolder(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) })).toBeUndefined()
    await expect(pickFolder(async () => { throw new Error('denied') })).rejects.toThrow('denied')
    expect((await pickFolder(async () => root))?.name).toBe('repo')
  })
})
