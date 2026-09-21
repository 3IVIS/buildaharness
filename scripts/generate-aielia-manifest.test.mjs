import { describe, it, expect } from 'vitest'
import { buildManifest, checkAssetUrls, platformKeyFromAssetName } from './generate-aielia-manifest.mjs'

const H = (c) => c.repeat(64)
const file = (name, c, size = 100) => ({ name, size, sidecar: `${H(c)}  ${name}\n` })
const FILES = [
  file('aielia-darwin-arm64', 'a'),
  file('aielia-darwin-x64', 'b'),
  file('aielia-linux-x64', 'c'),
  file('aielia-win32-x64.exe', 'D'),
  { name: 'aielia-linux-x64.sha256', size: 1, sidecar: '' },
]

describe('generate-aielia-manifest', () => {
  it('maps asset names to platform keys and ignores sidecars', () => {
    expect(platformKeyFromAssetName('aielia-linux-x64')).toBe('linux-x64')
    expect(platformKeyFromAssetName('aielia-win32-x64.exe')).toBe('win32-x64')
    expect(platformKeyFromAssetName('aielia-linux-x64.sha256')).toBeNull()
  })

  it('emits the schema self-update.ts parses: tag-scoped URLs, lowercased sha256, sizes', () => {
    const m = buildManifest({ tag: 'aielia-v0.3.1', repo: '3IVIS/buildaharness', files: FILES })
    expect(m.tag).toBe('aielia-v0.3.1')
    expect(m.version).toBe('0.3.1')
    expect(Object.keys(m.assets)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
    expect(m.assets['win32-x64']).toEqual({
      url: 'https://github.com/3IVIS/buildaharness/releases/download/aielia-v0.3.1/aielia-win32-x64.exe',
      sha256: H('d'),
      size: 100,
    })
    expect(JSON.stringify(m)).not.toContain('/releases/latest')
  })

  it('refuses a non-aielia tag, a missing platform, and a missing/garbled checksum', () => {
    expect(() => buildManifest({ tag: 'harness-v1.0.0', repo: 'o/r', files: FILES })).toThrow(/does not start with/)
    expect(() => buildManifest({ tag: 'aielia-v0.3.1', repo: 'o/r', files: FILES.slice(1) })).toThrow(/missing binaries for: darwin-arm64/)
    const bad = [...FILES.slice(1), { name: 'aielia-darwin-arm64', size: 1, sidecar: 'nope' }]
    expect(() => buildManifest({ tag: 'aielia-v0.3.1', repo: 'o/r', files: bad })).toThrow(/No sha256/)
  })

  it('checkAssetUrls reports every non-200 and any thrown network error', async () => {
    const m = buildManifest({ tag: 'aielia-v0.3.1', repo: 'o/r', files: FILES })
    const ok = await checkAssetUrls(m, async () => ({ status: 200 }))
    expect(ok).toEqual([])
    const failures = await checkAssetUrls(m, async (url) => {
      if (url.endsWith('linux-x64')) return { status: 404 }
      if (url.endsWith('.exe')) throw new Error('boom')
      return { status: 200 }
    })
    expect(failures).toHaveLength(2)
    expect(failures.join('\n')).toMatch(/linux-x64: HTTP 404/)
    expect(failures.join('\n')).toMatch(/win32-x64: boom/)
  })
})
