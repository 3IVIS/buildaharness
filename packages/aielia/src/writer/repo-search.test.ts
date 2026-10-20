import { describe, it, expect } from 'vitest'
import { createRepoIndex, buildRepoIndex } from './repo-search.js'

const FILES = new Map([
  ['src/a.ts', 'export const MAX = 800\nexport const name = "alpha"\n'],
  ['src/b.ts', 'const x = 1\n// MAX is 5\n'],
  ['README.md', '# Title\nUses Node 22.\n'],
])

describe('the repository index', () => {
  it('searches lines case-insensitively, as path:line, and can be limited by glob', () => {
    const idx = createRepoIndex(FILES)
    expect(idx.search('max')).toBe('src/a.ts:1: export const MAX = 800\nsrc/b.ts:2: // MAX is 5')
    expect(idx.search('max', '*.ts')).toContain('src/a.ts:1')
    expect(idx.search('max', 'README')).toMatch(/^No lines match/)
    expect(idx.search('node 22', '*.md')).toBe('README.md:2: Uses Node 22.')
  })
  it('searches an invalid pattern as plain text instead of failing', () => {
    expect(createRepoIndex(new Map([['a.txt', 'a (b\n']])).search('(b')).toBe('a.txt:1: a (b')
  })
  it('reads numbered line ranges and lists folders', () => {
    const idx = createRepoIndex(FILES)
    expect(idx.readLines('src/a.ts', 2, 2)).toContain('2: export const name = "alpha"')
    expect(idx.readLines('nope.ts')).toMatch(/No file/)
    expect(idx.list('')).toBe('README.md\nsrc/ (2 files)')
    expect(idx.list('src')).toBe('a.ts\nb.ts')
  })
  it('builds from a reader, leaving out empty and oversized files', async () => {
    const reader = { name: 'r', files: async () => ['a', 'b', 'c'], read: async (p: string) => (p === 'a' ? 'text' : p === 'b' ? '  ' : 'x'.repeat(400_000)) }
    const idx = await buildRepoIndex(reader)
    expect(idx.fileCount).toBe(1)
    expect(idx.has('a')).toBe(true)
  })
})
