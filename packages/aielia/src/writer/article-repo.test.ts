import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { MAX_PATHS_SENT, pathsToSend, pickRepoFiles } from './article-repo.js'

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
