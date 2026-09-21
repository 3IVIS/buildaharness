import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  compareVersions,
  assertHttps,
  shouldRunPassiveUpdateCheck,
  checkForUpdate,
  runUpdateCommand,
  replaceBinary,
  cleanupStaleUpdateFiles,
  updateAvailableNotice,
  CHECK_INTERVAL_MS,
} from './self-update.js'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0)
    expect(compareVersions('v0.3.2', '0.3.1')).toBeGreaterThan(0)
  })
  it('sorts a prerelease below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })
})

describe('assertHttps', () => {
  it('accepts https and rejects http/malformed unless the test override is set', () => {
    expect(() => assertHttps('https://myaielia.com/x')).not.toThrow()
    expect(() => assertHttps('http://myaielia.com/x')).toThrow(/non-HTTPS/)
    expect(() => assertHttps('not a url')).toThrow(/malformed/i)
    expect(() => assertHttps('http://127.0.0.1:1/x', true)).not.toThrow()
  })
})

describe('shouldRunPassiveUpdateCheck', () => {
  const base = { updateCheck: undefined, env: {}, stdinIsTty: true } as const
  it('runs for an interactive, non-opted-out session', () => {
    expect(shouldRunPassiveUpdateCheck({ ...base })).toBe(true)
    expect(shouldRunPassiveUpdateCheck({ ...base, updateCheck: 'enabled' })).toBe(true)
  })
  it('is skipped when stdin is not a TTY, when non-interactive approval is set, or when disabled', () => {
    expect(shouldRunPassiveUpdateCheck({ ...base, stdinIsTty: false })).toBe(false)
    expect(shouldRunPassiveUpdateCheck({ ...base, env: { ASSISTANT_NON_INTERACTIVE_APPROVAL: 'decline' } })).toBe(false)
    expect(shouldRunPassiveUpdateCheck({ ...base, updateCheck: 'disabled' })).toBe(false)
  })
})

describe('updateAvailableNotice', () => {
  it('branches the instruction on SEA vs npm', () => {
    expect(updateAvailableNotice('0.4.0', '0.3.1', true)).toContain('aielia update')
    expect(updateAvailableNotice('0.4.0', '0.3.1', false)).toContain('npm update -g @buildaharness/aielia')
  })
})

interface Mock {
  server: Server
  base: string
  hits: string[]
  headers: Array<Record<string, string | string[] | undefined>>
  routes: Map<string, { status?: number; body?: Buffer | string; headers?: Record<string, string> }>
}

async function startMock(): Promise<Mock> {
  const routes: Mock['routes'] = new Map()
  const hits: string[] = []
  const headers: Mock['headers'] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    headers.push(req.headers)
    const route = routes.get(req.url ?? '')
    if (!route) {
      res.statusCode = 404
      res.end('nope')
      return
    }
    res.writeHead(route.status ?? 200, route.headers)
    res.end(route.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, base, hits, headers, routes }
}

describe('self-update against a local mock server', () => {
  let dir: string
  let mock: Mock
  let logs: string[]
  const NEW_BIN = Buffer.from('#!/bin/sh\necho new-binary\n')

  const opts = (extra: Record<string, unknown> = {}) => ({
    manifestUrl: `${mock.base}/aielia-latest.json`,
    releasesApiUrl: `${mock.base}/releases`,
    allowInsecureHttp: true,
    dataDir: join(dir, 'data'),
    execPath: join(dir, 'aielia'),
    currentVersion: '0.3.1',
    platform: 'linux' as const,
    arch: 'x64',
    isSea: true,
    log: (l: string) => logs.push(l),
    ...extra,
  })

  const publishManifest = (sha256: string = sha(NEW_BIN), version = '0.4.0') => {
    mock.routes.set('/aielia-latest.json', {
      body: JSON.stringify({
        tag: `aielia-v${version}`,
        version,
        assets: { 'linux-x64': { url: `${mock.base}/dl/aielia-linux-x64`, sha256, size: NEW_BIN.length } },
      }),
    })
    mock.routes.set('/dl/aielia-linux-x64', { body: NEW_BIN })
    mock.routes.set('/dl/aielia-linux-x64.sha256', { body: `${sha(NEW_BIN)}  aielia-linux-x64\n` })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aielia-update-'))
    writeFileSync(join(dir, 'aielia'), 'old-binary')
    mock = await startMock()
    logs = []
  })
  afterEach(async () => {
    await new Promise((r) => mock.server.close(r))
    rmSync(dir, { recursive: true, force: true })
  })

  it('downloads, verifies against the manifest hash, and atomically replaces the binary (Unix)', async () => {
    publishManifest()
    expect(await runUpdateCommand(opts())).toBe(0)
    expect(readFileSync(join(dir, 'aielia'))).toEqual(NEW_BIN)
    expect(statSync(join(dir, 'aielia')).mode & 0o111).not.toBe(0)
    expect(existsSync(join(dir, 'aielia.update.tmp'))).toBe(false)
    expect(logs.join('\n')).toContain('0.3.1 → 0.4.0')
  })

  it('--dry-run reports the update but downloads nothing and leaves the binary alone', async () => {
    publishManifest()
    expect(await runUpdateCommand(opts({ dryRun: true }))).toBe(0)
    expect(readFileSync(join(dir, 'aielia'), 'utf8')).toBe('old-binary')
    expect(mock.hits).not.toContain('/dl/aielia-linux-x64')
    expect(logs.join('\n')).toContain('Update available')
  })

  it('reports up to date without downloading when the release is not newer', async () => {
    publishManifest(undefined, '0.3.1')
    expect(await runUpdateCommand(opts())).toBe(0)
    expect(logs.join('\n')).toContain('up to date')
    expect(mock.hits).not.toContain('/dl/aielia-linux-x64')
  })

  it('refuses a checksum mismatch and keeps the old binary, cleaning up the temp file', async () => {
    publishManifest(sha('something else'))
    expect(await runUpdateCommand(opts())).toBe(1)
    expect(readFileSync(join(dir, 'aielia'), 'utf8')).toBe('old-binary')
    expect(existsSync(join(dir, 'aielia.update.tmp'))).toBe(false)
    expect(logs.join('\n')).toContain('Checksum mismatch')
  })

  it("refuses when the sidecar next to the binary disagrees with the manifest's hash", async () => {
    publishManifest()
    mock.routes.set('/dl/aielia-linux-x64.sha256', { body: sha('tampered') })
    expect(await runUpdateCommand(opts())).toBe(1)
    expect(readFileSync(join(dir, 'aielia'), 'utf8')).toBe('old-binary')
    expect(logs.join('\n')).toContain('disagrees')
  })

  it('refuses cleanly with an npm pointer when not running as a SEA, without any network call', async () => {
    publishManifest()
    expect(await runUpdateCommand(opts({ isSea: false }))).toBe(1)
    expect(logs.join('\n')).toContain('npm update -g @buildaharness/aielia')
    expect(mock.hits).toEqual([])
  })

  it('refuses a release with no build for this platform', async () => {
    publishManifest()
    expect(await runUpdateCommand(opts({ arch: 'arm64' }))).toBe(1)
    expect(logs.join('\n')).toContain('no build for linux-arm64')
  })

  it('refuses a non-HTTPS manifest URL without the test override', async () => {
    expect(await runUpdateCommand(opts({ allowInsecureHttp: false }))).toBe(1)
    expect(mock.hits).toEqual([])
  })

  it('falls back to the GitHub Releases API (aielia-v* tags only, never drafts) and verifies via the sidecar', async () => {
    // manifest route absent → 404 → fallback
    mock.routes.set('/releases', {
      body: JSON.stringify([
        { tag_name: 'harness-v9.9.9', assets: [] },
        { tag_name: 'aielia-v0.5.0', draft: true, assets: [] },
        {
          tag_name: 'aielia-v0.4.0',
          assets: [
            { name: 'aielia-linux-x64', browser_download_url: `${mock.base}/dl/aielia-linux-x64`, size: NEW_BIN.length },
            { name: 'aielia-linux-x64.sha256', browser_download_url: `${mock.base}/dl/aielia-linux-x64.sha256` },
          ],
        },
      ]),
      headers: { etag: '"abc"' },
    })
    mock.routes.set('/dl/aielia-linux-x64', { body: NEW_BIN })
    mock.routes.set('/dl/aielia-linux-x64.sha256', { body: sha(NEW_BIN) })
    expect(await runUpdateCommand(opts())).toBe(0)
    expect(readFileSync(join(dir, 'aielia'))).toEqual(NEW_BIN)
  })

  it('Windows leg: renames the running exe aside to .old, and cleanupStaleUpdateFiles removes it next launch', async () => {
    publishManifest()
    expect(await runUpdateCommand(opts({ platform: 'win32' }))).toBe(1) // no win32-x64 asset in this manifest
    replaceBinary(join(dir, 'aielia'), (() => { writeFileSync(join(dir, 'new'), 'new-exe'); return join(dir, 'new') })(), 'win32')
    expect(readFileSync(join(dir, 'aielia'), 'utf8')).toBe('new-exe')
    expect(readFileSync(join(dir, 'aielia.old'), 'utf8')).toBe('old-binary')
    cleanupStaleUpdateFiles(join(dir, 'aielia'))
    expect(existsSync(join(dir, 'aielia.old'))).toBe(false)
    expect(readFileSync(join(dir, 'aielia'), 'utf8')).toBe('new-exe')
  })

  describe('checkForUpdate (passive)', () => {
    it('reports an available update, then serves the cache without a network call inside 24h', async () => {
      publishManifest()
      let t = 1_000_000
      const o = opts({ now: () => t })
      expect(await checkForUpdate(o)).toEqual({ latestVersion: '0.4.0', latestTag: 'aielia-v0.4.0', updateAvailable: true })
      const hitsAfterFirst = mock.hits.length
      t += CHECK_INTERVAL_MS - 1
      expect((await checkForUpdate(o))?.updateAvailable).toBe(true)
      expect(mock.hits.length).toBe(hitsAfterFirst)
      t += 2
      await checkForUpdate(o)
      expect(mock.hits.length).toBeGreaterThan(hitsAfterFirst)
    })

    it('sends a plain GET: no query string, no cookies/identifiers beyond the default headers', async () => {
      publishManifest()
      await checkForUpdate(opts())
      expect(mock.hits).toEqual(['/aielia-latest.json'])
      expect(Object.keys(mock.headers[0])).not.toContain('cookie')
      expect(Object.keys(mock.headers[0])).not.toContain('authorization')
    })

    it('re-sends the cached ETag to the GitHub API and treats a 304 as "unchanged"', async () => {
      mock.routes.set('/releases', {
        body: JSON.stringify([{ tag_name: 'aielia-v0.4.0', assets: [] }]),
        headers: { etag: '"v1"' },
      })
      let t = 0
      const o = opts({ now: () => t })
      expect((await checkForUpdate(o))?.latestVersion).toBe('0.4.0')
      t += CHECK_INTERVAL_MS + 1
      mock.routes.set('/releases', { status: 304 })
      const r = await checkForUpdate(o)
      expect(r).toEqual({ latestVersion: '0.4.0', latestTag: 'aielia-v0.4.0', updateAvailable: true })
      expect(mock.headers.at(-1)?.['if-none-match']).toBe('"v1"')
    })

    it('resolves null (never throws) when every source fails', async () => {
      expect(await checkForUpdate(opts())).toBeNull()
    })

    it('resolves null on a non-HTTPS URL rather than throwing', async () => {
      expect(await checkForUpdate(opts({ allowInsecureHttp: false }))).toBeNull()
      expect(mock.hits).toEqual([])
    })

    it('reports no update when already current', async () => {
      publishManifest(undefined, '0.3.1')
      expect((await checkForUpdate(opts()))?.updateAvailable).toBe(false)
    })
  })
})

