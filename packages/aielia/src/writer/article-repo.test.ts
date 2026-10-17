import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { MAX_OUTLINE_LINES, MAX_PATHS_SENT, folderOutline, pathsToSend, pathsUnder, pickRepoFiles, pickRepoFolders } from './article-repo.js'

const llm = (reply: unknown | Error, seen: string[] = []): ILLMClient =>
  ({ callChatStructured: async (m: { role: string; content: string }[]) => { seen.push(m[1].content); if (reply instanceof Error) throw reply; return { content: JSON.stringify(reply) } } }) as unknown as ILLMClient

describe('pickRepoFiles', () => {
  it('keeps only paths that are in the list, once each, at most three, and sends the claim with the paths', async () => {
    const seen: string[] = []
    const r = await pickRepoFiles({ claim: 'The cap is 15,000 characters', paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }, llm({ paths: ['b.ts', 'zzz.ts', 'b.ts', 'a.ts', 'c.ts', 'd.ts'] }, seen))
    expect(r).toEqual({ status: 'picked', paths: ['b.ts', 'a.ts', 'c.ts'] })
    expect(JSON.parse(seen[0])).toEqual({ claim: 'The cap is 15,000 characters', paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] })
  })
  it('fails quietly on a model error or a bad answer, and asks nothing of an empty repository', async () => {
    expect((await pickRepoFiles({ claim: 'x', paths: ['a.ts'] }, llm(new Error('503')))).status).toBe('failed')
    expect((await pickRepoFiles({ claim: 'x', paths: ['a.ts'] }, llm({ nope: 1 }))).status).toBe('failed')
    const seen: string[] = []
    expect(await pickRepoFiles({ claim: 'x', paths: [] }, llm({ paths: [] }, seen))).toEqual({ status: 'picked', paths: [] })
    expect(seen).toHaveLength(0)
  })
  it('sends a long list without test and fixture files, cut to the limit', () => {
    const many = [...Array.from({ length: 1400 }, (_, i) => `src/m${i}.ts`), ...Array.from({ length: 400 }, (_, i) => `tests/t${i}.ts`), 'src/x.test.ts']
    const sent = pathsToSend(many)
    expect(sent).toHaveLength(MAX_PATHS_SENT - 100 > 0 ? 1400 : MAX_PATHS_SENT)
    expect(sent.some((p) => p.startsWith('tests/') || p.endsWith('.test.ts'))).toBe(false)
    expect(pathsToSend(['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('large repositories', () => {
  const big = [
    ...Array.from({ length: 900 }, (_, i) => `benchmarking/run${i % 40}/t${i}.json`),
    ...Array.from({ length: 30 }, (_, i) => `packages/aielia/src/m${i}.ts`),
    ...Array.from({ length: 20 }, (_, i) => `packages/chat-ui/src/c${i}.ts`),
    'README.md',
  ]
  it('outlines the folders with their file counts, as deep as fits', () => {
    const o = folderOutline(big)
    expect(o.length).toBeLessThanOrEqual(MAX_OUTLINE_LINES)
    expect(o).toContainEqual({ folder: 'packages/aielia/src/', files: 30 })
    expect(o).toContainEqual({ folder: './', files: 1 })
    expect(o.find((l) => l.folder.startsWith('benchmarking/'))).toBeDefined()
    expect(folderOutline(['a.ts', 'b.ts'])).toEqual([{ folder: './', files: 2 }])
  })
  it('takes the paths under the chosen folders (the top level alone for "./")', () => {
    expect(pathsUnder(big, ['packages/chat-ui/src/'])).toHaveLength(20)
    expect(pathsUnder(big, ['./'])).toEqual(['README.md'])
  })
  it('keeps only folders from the outline, tolerating a shown count, at most four', async () => {
    const reply = { folders: ['packages/aielia/src/ (30)', 'nope/', 'packages/aielia/src/', 'packages/chat-ui/src/', './', 'benchmarking/run1/'] }
    const r = await pickRepoFolders({ claim: 'x', paths: big }, llm(reply))
    expect(r.status).toBe('picked')
    expect(r.folders.slice(0, 2)).toEqual(['packages/aielia/src/', 'packages/chat-ui/src/'])
    expect(r.folders.length).toBeLessThanOrEqual(4)
    expect((await pickRepoFolders({ claim: 'x', paths: big }, llm(new Error('503')))).status).toBe('failed')
  })
})
