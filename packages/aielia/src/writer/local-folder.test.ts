import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import { folderFromFsBackend, folderFromListing, matchFolderFiles, walkFolder, type FolderReader } from './local-folder.js'

const NOW = '2026-10-17T10:00:00.000Z'
const MD = '# Post\n\nThe cache holds 100 items.\n'
const llm = ((): ILLMClient => ({ callChatStructured: async () => ({ content: JSON.stringify({ impacts: [] }) }) }) as unknown as ILLMClient)()

function reader(files: Record<string, string>, name = 'repo'): FolderReader & { files_: Record<string, string> } {
  return { name, files_: files, files: async () => Object.keys(files), read: async (p) => files[p] }
}

describe('walking a folder', () => {
  it('lists readable text and code files, leaves out skipped folders and unreadable kinds, and sorts', async () => {
    const tree: Record<string, { name: string; directory: boolean }[]> = {
      '': [{ name: 'src', directory: true }, { name: 'node_modules', directory: true }, { name: '.git', directory: true }, { name: 'README.md', directory: false }, { name: 'logo.png', directory: false }],
      src: [{ name: 'b.ts', directory: false }, { name: 'a.ts', directory: false }],
    }
    expect(await walkFolder(async (d) => tree[d] ?? [])).toEqual(['README.md', 'src/a.ts', 'src/b.ts'])
  })
  it('works over a backend that only reads text and directory names', async () => {
    const files: Record<string, string> = { '/w/repo/a.ts': 'A', '/w/repo/lib/b.py': 'B', '/w/repo/img.png': 'x' }
    const dirs: Record<string, string[]> = { '/w/repo': ['a.ts', 'lib', 'img.png'], '/w/repo/lib': ['b.py'] }
    const fs = { readTextFile: async (p: string) => files[p], readDir: async (p: string) => { if (!dirs[p]) throw new Error('not a directory'); return dirs[p] } }
    const r = folderFromFsBackend(fs, '/w/repo', 'repo')
    expect((await r.files()).sort()).toEqual(['a.ts', 'lib/b.py'])
    expect(await r.read('lib/b.py')).toBe('B')
    expect(await r.read('nope.ts')).toBeUndefined()
  })
  it('finds files by the words typed, shortest first', () => {
    expect(matchFolderFiles(['src/cache/lru.ts', 'cache.ts', 'src/other.ts'], 'CACHE ts')).toEqual(['cache.ts', 'src/cache/lru.ts'])
    expect(matchFolderFiles(['a', 'b'], '  ')).toEqual(['a', 'b'])
  })
})

describe('using files from a folder', () => {
  it('stores a file under folder/path as code, uses the same address again, and reports a changed or missing file', async () => {
    const r = reader({ 'src/cache.ts': 'const LIMIT = 100', 'notes.txt': 'n', 'logo.png': 'x' })
    const svc = new ArticleService({ store: createMemoryArticleStore(), llm, now: () => NOW })
    const id = await svc.create('Post', MD)
    const add = await svc.addFolderFile(id, r, 'src/cache.ts')
    expect(add.status).toBe('added')
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ kind: 'code', address: 'repo/src/cache.ts', passage: 'const LIMIT = 100' })
    expect((await svc.addFolderFile(id, r, 'src/cache.ts')).status).toBe('unchanged')
    expect((await svc.get(id)).meta.sources).toHaveLength(1)
    expect((await svc.addFolderFile(id, r, 'logo.png')).status).toBe('unsupported')
    expect((await svc.addFolderFile(id, r, 'gone.ts')).status).toBe('missing')

    r.files_['src/cache.ts'] = 'const LIMIT = 50'
    expect(await svc.recheckFolder(id, r)).toEqual({ unchanged: 0, changed: ['repo/src/cache.ts'], missing: [] })
    expect((await svc.get(id)).meta.sources[0]).toMatchObject({ passage: 'const LIMIT = 100', fetchedPassage: 'const LIMIT = 50' })
    delete r.files_['src/cache.ts']
    expect((await svc.recheckFolder(id, r)).missing).toEqual(['repo/src/cache.ts'])
    expect(await svc.recheckFolder(id, reader({}, 'other'))).toEqual({ unchanged: 0, changed: [], missing: [] })
  })
})

describe('folderFromListing', () => {
  const tree: Record<string, { name: string; directory: boolean }[]> = {
    '/w/repo': [{ name: 'README.md', directory: false }, { name: 'src', directory: true }, { name: 'node_modules', directory: true }, { name: 'logo.png', directory: false }],
    '/w/repo/src': [{ name: 'a.ts', directory: false }, { name: 'deep', directory: true }],
    '/w/repo/src/deep': [{ name: 'b.ts', directory: false }],
    '/w/repo/node_modules': [{ name: 'x.js', directory: false }],
  }
  const files: Record<string, string> = { '/w/repo/README.md': '# r', '/w/repo/src/a.ts': 'a', '/w/repo/src/deep/b.ts': 'b' }
  const fs = { listDir: async (p: string) => { const t = tree[p]; if (!t) throw new Error('no such folder'); return t }, readTextFile: async (p: string) => files[p] }

  it('walks down into subfolders using the listing, leaving out dependency folders and files that are not text or code', async () => {
    const r = folderFromListing(fs, '/w/repo/', 'repo')
    expect(r.name).toBe('repo')
    expect(await r.files()).toEqual(['README.md', 'src/a.ts', 'src/deep/b.ts'])
  })
  it('reads a file by its path under the folder, and gives undefined for one that cannot be read', async () => {
    const r = folderFromListing({ ...fs, readTextFile: async (p: string) => { if (p.endsWith('gone.ts')) throw new Error('missing'); return files[p] } }, '/w/repo', 'repo')
    expect(await r.read('src/deep/b.ts')).toBe('b')
    expect(await r.read('src/gone.ts')).toBeUndefined()
  })
})
