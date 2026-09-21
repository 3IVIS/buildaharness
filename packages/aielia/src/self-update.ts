/**
 * Self-update for the standalone (Node SEA) `aielia` binary, plus the passive "an update is
 * available" check that runs alongside the interactive session.
 *
 * Release discovery never uses GitHub's `/releases/latest` — this repo publishes many product
 * lines (`harness-v*`, `pa-v*`, `aielia-v*`, …) into one Releases list, so "latest" is repo-wide,
 * not per product. Instead the product-scoped manifest at myaielia.com is tried first, then the
 * Releases API filtered to `aielia-v*` tags.
 *
 * Every network function takes injectable `fetchFn`/URLs/clock/paths so self-update.test.ts can
 * exercise the whole download → verify → replace flow against a local mock HTTP server.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { CLI_VERSION } from './version.js'
import { loadSea } from './mcp-server-asset.js'

export const MANIFEST_URL = 'https://myaielia.com/aielia-latest.json'
export const RELEASES_API_URL = 'https://api.github.com/repos/3IVIS/buildaharness/releases?per_page=50'
export const RELEASE_TAG_PREFIX = 'aielia-v'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const NPM_UPDATE_HINT = 'npm update -g @buildaharness/aielia'

export interface ReleaseAsset {
  url: string
  /** From the manifest — the trusted hash (a different origin than the binary's github.com URL). Absent on the GitHub-API fallback. */
  sha256?: string
  size?: number
}

export interface ReleaseInfo {
  tag: string
  version: string
  /** Keyed `<process.platform>-<process.arch>`, e.g. `linux-x64`, `darwin-arm64`, `win32-x64`. */
  assets: Record<string, ReleaseAsset>
  source: 'manifest' | 'github'
}

export interface UpdateCheckCache {
  checkedAt: number
  latestVersion?: string
  latestTag?: string
  /** ETag of the GitHub Releases API response, for conditional re-requests. */
  etag?: string
}

export interface SelfUpdateOptions {
  fetchFn?: typeof fetch
  manifestUrl?: string
  releasesApiUrl?: string
  /** Test-only: permit http:// manifest/asset URLs (a local mock server). Production never sets this. */
  allowInsecureHttp?: boolean
  now?: () => number
  /** Defaults to `~/.buildaharness/personal-assistant`. */
  dataDir?: string
  currentVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  /** Path of the running binary. Defaults to `process.execPath` (which, in a SEA, is the binary itself). */
  execPath?: string
  /** Defaults to whether `node:sea` reports a SEA. */
  isSea?: boolean
  log?: (line: string) => void
}

const defaultDataDir = (): string => join(homedir(), '.buildaharness', 'personal-assistant')
const cachePath = (dataDir: string): string => join(dataDir, 'update-check.json')

/** Numeric `major.minor.patch` comparison; a `-prerelease` suffix sorts below the same release. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2)
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: pre !== undefined }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1
  return 0
}

/** Throws on anything but https:// (unless the test-only override is set) — applied to the manifest URL and every asset URL. */
export function assertHttps(url: string, allowInsecureHttp = false): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error(`Refusing malformed URL: ${url}`)
  }
  if (protocol === 'https:') return
  if (protocol === 'http:' && allowInsecureHttp) return
  throw new Error(`Refusing non-HTTPS URL: ${url}`)
}

/**
 * Whether the passive check may make its unsolicited outbound request at all. Off for scripted/CI
 * runs (stdin not a TTY, or `ASSISTANT_NON_INTERACTIVE_APPROVAL` set) and when opted out via
 * `ASSISTANT_UPDATE_CHECK=disabled` / `/config set updateCheck disabled`.
 */
export function shouldRunPassiveUpdateCheck(input: {
  updateCheck: 'enabled' | 'disabled' | undefined
  env: NodeJS.ProcessEnv
  stdinIsTty: boolean
}): boolean {
  if (input.updateCheck === 'disabled') return false
  if (!input.stdinIsTty) return false
  if (input.env.ASSISTANT_NON_INTERACTIVE_APPROVAL !== undefined) return false
  return true
}

function platformKey(o: SelfUpdateOptions): string {
  return `${o.platform ?? process.platform}-${o.arch ?? process.arch}`
}

function readCache(dataDir: string): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(dataDir), 'utf8')) as Partial<UpdateCheckCache>
    if (typeof parsed.checkedAt !== 'number') return null
    return parsed as UpdateCheckCache
  } catch {
    return null
  }
}

function writeCache(dataDir: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(cachePath(dataDir), JSON.stringify(cache))
  } catch {
    // A read-only home dir just means the check isn't throttled — never worth failing a session over.
  }
}

function parseManifest(json: unknown, allowInsecureHttp: boolean): ReleaseInfo {
  const m = json as { tag?: unknown; version?: unknown; assets?: unknown }
  if (typeof m?.tag !== 'string' || typeof m.version !== 'string' || typeof m.assets !== 'object' || m.assets === null) {
    throw new Error('Malformed update manifest')
  }
  const assets: Record<string, ReleaseAsset> = {}
  for (const [key, raw] of Object.entries(m.assets as Record<string, Record<string, unknown>>)) {
    if (typeof raw?.url !== 'string') continue
    assertHttps(raw.url, allowInsecureHttp)
    assets[key] = {
      url: raw.url,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : undefined,
      size: typeof raw.size === 'number' ? raw.size : undefined,
    }
  }
  return { tag: m.tag, version: m.version, assets, source: 'manifest' }
}

interface GithubRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name: string; browser_download_url: string; size?: number }>
}

/** `aielia-linux-x64` / `aielia-win32-x64.exe` → `linux-x64` / `win32-x64`; sidecar `.sha256` files are not binaries. */
function assetKeyFromName(name: string): string | null {
  const m = /^aielia-([a-z0-9]+-[a-z0-9]+?)(?:\.exe)?$/.exec(name)
  return m ? m[1] : null
}

function parseGithubReleases(releases: GithubRelease[], allowInsecureHttp: boolean): ReleaseInfo | null {
  let best: ReleaseInfo | null = null
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(RELEASE_TAG_PREFIX)) continue
    const version = r.tag_name.slice(RELEASE_TAG_PREFIX.length)
    if (best && compareVersions(version, best.version) <= 0) continue
    const assets: Record<string, ReleaseAsset> = {}
    for (const a of r.assets ?? []) {
      const key = assetKeyFromName(a.name)
      if (!key) continue
      assertHttps(a.browser_download_url, allowInsecureHttp)
      assets[key] = { url: a.browser_download_url, size: a.size }
    }
    best = { tag: r.tag_name, version, assets, source: 'github' }
  }
  return best
}

async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' })
}

/**
 * Resolves the latest release: the product-scoped manifest first, the GitHub Releases API (filtered
 * to `aielia-v*` tags, ETag-cached) as fallback. A plain GET each — no query string, no
 * identifiers, default User-Agent only. Returns `notModified` when the API answered 304 to the
 * cached ETag; the caller then keeps the cached version.
 */
export async function fetchLatestRelease(
  options: SelfUpdateOptions,
  etag?: string,
): Promise<{ release: ReleaseInfo; etag?: string } | { notModified: true }> {
  const fetchFn = options.fetchFn ?? fetch
  const insecure = options.allowInsecureHttp ?? false
  const manifestUrl = options.manifestUrl ?? MANIFEST_URL
  const apiUrl = options.releasesApiUrl ?? RELEASES_API_URL
  assertHttps(manifestUrl, insecure)
  assertHttps(apiUrl, insecure)

  let manifestError: unknown
  try {
    const res = await getJson(fetchFn, manifestUrl)
    if (res.ok) return { release: parseManifest(await res.json(), insecure) }
    manifestError = new Error(`manifest HTTP ${res.status}`)
  } catch (err) {
    manifestError = err
  }

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (etag) headers['If-None-Match'] = etag
  const res = await getJson(fetchFn, apiUrl, headers)
  if (res.status === 304 && etag) return { notModified: true }
  if (!res.ok) {
    throw new Error(`Could not check for updates (manifest: ${(manifestError as Error)?.message ?? manifestError}; GitHub: HTTP ${res.status})`)
  }
  const release = parseGithubReleases((await res.json()) as GithubRelease[], insecure)
  if (!release) throw new Error(`No ${RELEASE_TAG_PREFIX}* release found`)
  return { release, etag: res.headers.get('etag') ?? undefined }
}

export interface UpdateCheckResult {
  latestVersion: string
  latestTag?: string
  updateAvailable: boolean
}

/**
 * The passive check: 24h-throttled via `<dataDir>/update-check.json`. Never throws — any failure
 * (offline, malformed manifest, …) resolves to `null`, since an unsolicited background check must
 * never disturb a session. Callers are responsible for gating it with `shouldRunPassiveUpdateCheck`
 * first and for not awaiting it before the prompt renders.
 */
export async function checkForUpdate(options: SelfUpdateOptions = {}): Promise<UpdateCheckResult | null> {
  const now = (options.now ?? Date.now)()
  const dataDir = options.dataDir ?? defaultDataDir()
  const current = options.currentVersion ?? CLI_VERSION
  const cached = readCache(dataDir)
  try {
    if (cached?.latestVersion && now - cached.checkedAt < CHECK_INTERVAL_MS) {
      return { latestVersion: cached.latestVersion, latestTag: cached.latestTag, updateAvailable: compareVersions(cached.latestVersion, current) > 0 }
    }
    const result = await fetchLatestRelease(options, cached?.etag)
    if ('notModified' in result) {
      writeCache(dataDir, { ...cached!, checkedAt: now })
      const v = cached!.latestVersion!
      return { latestVersion: v, latestTag: cached!.latestTag, updateAvailable: compareVersions(v, current) > 0 }
    }
    writeCache(dataDir, { checkedAt: now, latestVersion: result.release.version, latestTag: result.release.tag, etag: result.etag })
    return { latestVersion: result.release.version, latestTag: result.release.tag, updateAvailable: compareVersions(result.release.version, current) > 0 }
  } catch {
    return null
  }
}

/** One-line notice; the instruction branches on how this copy was installed. */
export function updateAvailableNotice(latestVersion: string, currentVersion: string, isSea: boolean): string {
  const how = isSea ? 'run `aielia update`' : `run \`${NPM_UPDATE_HINT}\``
  return `A newer aielia is available (${currentVersion} → ${latestVersion}) — ${how}.`
}

/** `isSea` the way the rest of the CLI decides it — false under npm/tsx, where nothing can be self-replaced. */
export function isRunningAsSea(): boolean {
  return loadSea() !== null
}

/** Removes leftovers of a previous update (the Windows `.old` rename-aside copy, an interrupted temp download). Never throws. */
export function cleanupStaleUpdateFiles(execPath: string = process.execPath): void {
  for (const stale of [`${execPath}.old`, `${execPath}.update.tmp`]) {
    try {
      if (existsSync(stale)) rmSync(stale, { force: true })
    } catch {
      // Still locked (e.g. the previous process hasn't fully exited) — the next launch retries.
    }
  }
}

/**
 * Replaces the binary at `execPath` with the already-verified file at `newFile` (same directory).
 * Unix: `rename` over the running binary — POSIX lets a still-open inode be replaced. Windows can't
 * overwrite a running exe, so the current one is renamed aside to `.old` first (cleaned up on the
 * next launch by `cleanupStaleUpdateFiles`), rolling back if the second rename fails.
 */
export function replaceBinary(execPath: string, newFile: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const aside = `${execPath}.old`
    rmSync(aside, { force: true })
    renameSync(execPath, aside)
    try {
      renameSync(newFile, execPath)
    } catch (err) {
      renameSync(aside, execPath)
      throw err
    }
    return
  }
  chmodSync(newFile, 0o755)
  renameSync(newFile, execPath)
}

/** Streams `url` to `dest`, returning the lowercase hex sha256 of exactly the bytes written. */
async function downloadTo(fetchFn: typeof fetch, url: string, dest: string): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  const hash = createHash('sha256')
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(dest),
  )
  return hash.digest('hex')
}

async function fetchSidecarHash(fetchFn: typeof fetch, assetUrl: string): Promise<string | null> {
  try {
    const res = await getJson(fetchFn, `${assetUrl}.sha256`)
    if (!res.ok) return null
    const m = /[0-9a-fA-F]{64}/.exec(await res.text())
    return m ? m[0].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * `aielia update [--dry-run]`. Returns the process exit code (0 = up to date / updated / dry-run
 * reported; 1 = refused or failed) and reports through `options.log`. Always does a fresh check —
 * never the throttled cache — and works regardless of the `updateCheck` opt-out.
 */
export async function runUpdateCommand(input: { dryRun?: boolean } & SelfUpdateOptions = {}): Promise<number> {
  const log = input.log ?? ((line: string) => console.log(line))
  const isSea = input.isSea ?? isRunningAsSea()
  const current = input.currentVersion ?? CLI_VERSION
  const dataDir = input.dataDir ?? defaultDataDir()
  const fetchFn = input.fetchFn ?? fetch
  const insecure = input.allowInsecureHttp ?? false

  if (!isSea) {
    log(`aielia update only replaces the standalone binary. This copy was installed with npm — run: ${NPM_UPDATE_HINT}`)
    return 1
  }

  let release: ReleaseInfo
  try {
    const result = await fetchLatestRelease(input) // no etag: an explicit update always wants a full answer
    if ('notModified' in result) throw new Error('unexpected 304')
    release = result.release
    writeCache(dataDir, { checkedAt: (input.now ?? Date.now)(), latestVersion: release.version, latestTag: release.tag, etag: result.etag })
  } catch (err) {
    log(`Could not check for updates: ${(err as Error).message}`)
    return 1
  }

  if (compareVersions(release.version, current) <= 0) {
    log(`aielia ${current} is up to date.`)
    return 0
  }

  const key = platformKey(input)
  const asset = release.assets[key]
  if (!asset) {
    log(`Release ${release.tag} has no build for ${key}.`)
    return 1
  }
  if (input.dryRun) {
    log(`Update available: ${current} → ${release.version} (${release.tag}). Would download ${asset.url}`)
    return 0
  }

  const execPath = input.execPath ?? process.execPath
  const tmp = `${execPath}.update.tmp`
  try {
    assertHttps(asset.url, insecure)
    log(`Downloading aielia ${release.version} (${key})…`)
    const actual = await downloadTo(fetchFn, asset.url, tmp)
    // Trust split: the binary comes from github.com, its hash from the manifest on myaielia.com —
    // verify against the manifest's hash so compromising one origin isn't enough. The sidecar file
    // next to the binary is only a cross-check (and the sole hash source on the GitHub-API fallback,
    // where both come from the same origin).
    const sidecar = await fetchSidecarHash(fetchFn, asset.url)
    const expected = asset.sha256 ?? sidecar
    if (!expected) throw new Error('No checksum available for this release — refusing to install an unverified binary')
    if (actual !== expected) throw new Error(`Checksum mismatch (expected ${expected}, got ${actual}) — download discarded`)
    if (asset.sha256 && sidecar && sidecar !== asset.sha256) {
      throw new Error('Checksum sidecar disagrees with the release manifest — download discarded')
    }
    mkdirSync(dirname(execPath), { recursive: true })
    replaceBinary(execPath, tmp, input.platform)
    log(`Updated aielia ${current} → ${release.version}. Restart to use the new version.`)
    return 0
  } catch (err) {
    rmSync(tmp, { force: true })
    log(`Update failed: ${(err as Error).message}`)
    return 1
  }
}
