import { describe, it, expect } from 'vitest'
import { githubRepoReader, parseGithubRepoAddress } from './repo-reader.js'

describe('parseGithubRepoAddress', () => {
  it('reads a repository address, with an optional branch, and the o/r shorthand; anything else is undefined', () => {
    expect(parseGithubRepoAddress('https://github.com/3IVIS/buildaharness')).toEqual({ owner: '3IVIS', repo: 'buildaharness' })
    expect(parseGithubRepoAddress('https://github.com/3IVIS/buildaharness.git/')).toEqual({ owner: '3IVIS', repo: 'buildaharness' })
    expect(parseGithubRepoAddress('https://github.com/o/r/tree/feature-x/src')).toEqual({ owner: 'o', repo: 'r', ref: 'feature-x', path: 'src' })
    expect(parseGithubRepoAddress('https://github.com/o/r/tree/main/packages/x')).toEqual({ owner: 'o', repo: 'r', ref: 'main', path: 'packages/x' })
    expect(parseGithubRepoAddress('o/r')).toEqual({ owner: 'o', repo: 'r' })
    expect(parseGithubRepoAddress('github.com/3IVIS/buildaharness')).toEqual({ owner: '3IVIS', repo: 'buildaharness' })
    expect(parseGithubRepoAddress('www.github.com/o/r/tree/main/src')).toEqual({ owner: 'o', repo: 'r', ref: 'main', path: 'src' })
    expect(parseGithubRepoAddress('https://example.com/o/r')).toBeUndefined()
    expect(parseGithubRepoAddress('http://github.com/o/r')).toBeUndefined()
    expect(parseGithubRepoAddress('github')).toBeUndefined()
  })
})

describe('githubRepoReader', () => {
  const tree = { tree: [
    { path: 'README.md', type: 'blob', size: 100 },
    { path: 'src/a.ts', type: 'blob', size: 100 },
    { path: 'src/big.ts', type: 'blob', size: 900_000 },
    { path: 'node_modules/x/index.js', type: 'blob', size: 10 },
    { path: 'logo.png', type: 'blob', size: 10 },
    { path: 'src', type: 'tree' },
  ] }
  function fake(calls: { url: string; headers?: Record<string, string> }[], files: Record<string, string> = {}, status = 200): typeof fetch {
    return (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers })
      if (url.includes('/git/trees/')) return new Response(JSON.stringify(tree), { status })
      const path = Object.keys(files).find((p) => url.includes(p))
      return path ? new Response(files[path]) : new Response('no', { status: 404 })
    }) as typeof fetch
  }
  it('lists readable text and code files only (no folders, builds, big files or images) and gives file addresses a link', async () => {
    const calls: { url: string }[] = []
    const r = githubRepoReader({ owner: 'o', repo: 'r' }, { fetchImpl: fake(calls) })
    expect(r.name).toBe('o/r')
    expect(await r.files()).toEqual(['README.md', 'src/a.ts'])
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/git/trees/HEAD?recursive=1')
    expect(r.addressOf?.('src/a.ts')).toBe('https://github.com/o/r/blob/HEAD/src/a.ts')
  })
  it('lists only the files under a folder when the address names one, and names the reader after it', async () => {
    const r = githubRepoReader({ owner: 'o', repo: 'r', path: 'src' }, { fetchImpl: fake([]) })
    expect(r.name).toBe('o/r/src')
    expect(await r.files()).toEqual(['src/a.ts'])
  })
  it('reads a file from raw.githubusercontent.com, or through the API with the token for a private repository, and says plainly when it cannot list', async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = []
    const pub = githubRepoReader({ owner: 'o', repo: 'r', ref: 'dev' }, { fetchImpl: fake(calls, { 'src/a.ts': 'let a = 1' }) })
    expect(await pub.read('src/a.ts')).toBe('let a = 1')
    expect(calls[0].url).toBe('https://raw.githubusercontent.com/o/r/dev/src/a.ts')
    expect(await pub.read('missing.ts')).toBeUndefined()
    const priv = githubRepoReader({ owner: 'o', repo: 'r' }, { token: 'ghp_x', fetchImpl: fake(calls, { 'src/a.ts': 'secret' }) })
    expect(await priv.read('src/a.ts')).toBe('secret')
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.github.com/repos/o/r/contents/src/a.ts?ref=HEAD', headers: { Authorization: 'Bearer ghp_x' } })
    await expect(githubRepoReader({ owner: 'o', repo: 'r' }, { fetchImpl: fake([], {}, 404) }).files()).rejects.toThrow(/private: add a GitHub token/)
    await expect(githubRepoReader({ owner: 'o', repo: 'r' }, { fetchImpl: fake([], {}, 403) }).files()).rejects.toThrow(/limiting requests/)
  })
})
