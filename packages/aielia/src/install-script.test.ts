// Exercises packages/aielia/install.sh end-to-end against a local mock HTTP server (and a file://
// manifest) via the script's test-only AIELIA_MANIFEST_URL / AIELIA_INSTALL_ALLOW_INSECURE overrides.
// install.ps1 has no sandbox coverage — it can only be verified on a real Windows machine.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh')
const platformKey = `${process.platform}-${process.arch}`
const supported = ['linux-x64', 'darwin-arm64', 'darwin-x64'].includes(platformKey) && process.platform !== 'win32'

const fakeBinary = (version: string) => `#!/bin/sh\necho ${version}\n`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe.skipIf(!supported)('install.sh', () => {
  let server: Server
  let base: string
  // path → body; mutated per test
  let routes: Record<string, string>
  let work: string
  let installDir: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = routes[req.url ?? '']
      if (body === undefined) { res.writeHead(404).end(); return }
      res.writeHead(200).end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'aielia-install-test-'))
    installDir = join(work, 'bin')
    routes = {}
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  /** Publishes a release: binary + sidecar + manifest (same shape as scripts/generate-aielia-manifest.mjs). */
  function publish(opts: { version?: string; manifestSha?: string; sidecarSha?: string | null; key?: string } = {}) {
    const version = opts.version ?? '0.4.0'
    const bin = fakeBinary(version)
    routes['/asset'] = bin
    if (opts.sidecarSha !== null) routes['/asset.sha256'] = `${opts.sidecarSha ?? sha(bin)}  aielia-${opts.key ?? platformKey}\n`
    const manifest = {
      tag: `aielia-v${version}`,
      version,
      assets: { [opts.key ?? platformKey]: { url: `${base}/asset`, sha256: opts.manifestSha ?? sha(bin), size: bin.length } },
    }
    routes['/aielia-latest.json'] = JSON.stringify(manifest, null, 2) + '\n'
  }

  // Async on purpose: a sync spawn would block this process's event loop, and with it the mock server.
  function run(args: string[] = [], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', [SCRIPT, ...args], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: work,
          AIELIA_INSTALL_DIR: installDir,
          AIELIA_MANIFEST_URL: `${base}/aielia-latest.json`,
          AIELIA_INSTALL_ALLOW_INSECURE: '1',
          ...env,
        },
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => resolve({ code, out }))
    })
  }
  const target = () => join(installDir, 'aielia')
  const installedVersion = () => spawnSync(target(), ['--version'], { encoding: 'utf8' }).stdout.trim()

  it('installs a verified, executable binary and hints at PATH', async () => {
    publish()
    const r = await run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('Checksum verified')
    expect(installedVersion()).toBe('0.4.0')
    expect(statSync(target()).mode & 0o111).not.toBe(0)
    expect(r.out).toContain('is not on your PATH')
  })

  it('omits the PATH hint when the install dir is already on PATH', async () => {
    publish()
    const r = await run([], { PATH: `${installDir}:${process.env.PATH ?? ''}` })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('is not on your PATH')
  })

  it('is idempotent: re-running with the same version is a no-op', async () => {
    publish()
    expect((await run()).code).toBe(0)
    const r = await run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('already installed')
    expect(r.out).toContain('up to date')
  })

  it('upgrades an older aielia binary in place, leaving no staging files behind', async () => {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(target(), fakeBinary('0.3.1'))
    chmodSync(target(), 0o755)
    publish({ version: '0.4.0' })
    const r = await run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('Upgrading aielia 0.3.1 → 0.4.0')
    expect(installedVersion()).toBe('0.4.0')
    expect(spawnSync('ls', ['-A', installDir], { encoding: 'utf8' }).stdout.trim()).toBe('aielia')
  })

  it('rejects a checksum mismatch against the manifest and installs nothing', async () => {
    publish({ manifestSha: 'a'.repeat(64) })
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('checksum mismatch')
    expect(existsSync(target())).toBe(false)
  })

  it('rejects a sidecar that disagrees with the manifest', async () => {
    publish({ sidecarSha: 'b'.repeat(64) })
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('sidecar disagrees')
    expect(existsSync(target())).toBe(false)
  })

  it('tolerates an unreachable sidecar (the manifest hash is authoritative)', async () => {
    publish({ sidecarSha: null })
    expect((await run()).code).toBe(0)
    expect(installedVersion()).toBe('0.4.0')
  })

  it('refuses to clobber an unrelated file without --force, and replaces it with --force', async () => {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(target(), 'not aielia at all\n')
    chmodSync(target(), 0o755)
    publish()
    const refused = await run()
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain('--force')
    expect(readFileSync(target(), 'utf8')).toBe('not aielia at all\n')

    const forced = await run(['--force'])
    expect(forced.code).toBe(0)
    expect(installedVersion()).toBe('0.4.0')
  })

  it('refuses to replace a symlink (e.g. an npm-linked aielia) without --force', async () => {
    mkdirSync(installDir, { recursive: true })
    const real = join(work, 'real-aielia')
    writeFileSync(real, fakeBinary('0.3.1'))
    chmodSync(real, 0o755)
    symlinkSync(real, target())
    publish()
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(readFileSync(real, 'utf8')).toBe(fakeBinary('0.3.1'))
  })

  it('hard-fails on a non-HTTPS manifest URL when the test override is not set', async () => {
    publish()
    const r = await run([], { AIELIA_INSTALL_ALLOW_INSECURE: '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('non-HTTPS')
    expect(existsSync(target())).toBe(false)
  })

  it('hard-fails when the manifest names a non-HTTPS asset URL', async () => {
    publish()
    routes['/aielia-latest.json'] = routes['/aielia-latest.json'].replace(`${base}/asset`, 'ftp://example.com/asset')
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('non-HTTPS')
  })

  it('fails clearly when the release has no binary for this platform', async () => {
    publish({ key: 'plan9-mips' })
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`no binary for ${platformKey}`)
  })

  it('rejects a manifest whose tag is not an aielia-v* tag', async () => {
    publish()
    routes['/aielia-latest.json'] = routes['/aielia-latest.json'].replace('"tag": "aielia-v0.4.0"', '"tag": "desktop-v0.4.0"')
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('unexpected tag')
  })

  it('works against a file:// manifest override', async () => {
    publish()
    const manifestFile = join(work, 'aielia-latest.json')
    writeFileSync(manifestFile, routes['/aielia-latest.json'])
    const r = await run([], { AIELIA_MANIFEST_URL: `file://${manifestFile}` })
    expect(r.code).toBe(0)
    expect(installedVersion()).toBe('0.4.0')
  })

  it('--help prints usage and exits 0; an unknown flag exits non-zero', async () => {
    expect((await run(['--help'])).out).toContain('Usage: install.sh')
    expect((await run(['--bogus'])).code).not.toBe(0)
  })
})
