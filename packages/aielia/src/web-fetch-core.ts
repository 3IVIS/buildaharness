/**
 * Runtime-agnostic SSRF guard + safe-fetch core used by web-tools.ts (desktop/CLI path). Split
 * out of web-tools.ts so the guard/redirect/byte-cap logic is one focused module instead of
 * living inline in the tool executor.
 *
 * packages/proxy/src/web-fetch.ts (POST /web/fetch, W2) intentionally carries its own copy of
 * this guard rather than importing this module as a workspace dependency — same call W1's
 * web-search.ts already made for the search parsing code: this package's only `exports` entry is
 * the whole `dist/index.js` bundle (nodemailer, the MCP SDK, the CLI), and this repo's proxy CI
 * job (and this plan's own suggested gate script) typechecks/tests packages/proxy without a
 * `build:personal-assistant` step first, so a real cross-package import isn't actually wired up
 * to build here. Keep the two guards in sync by hand if one changes — same discipline the ported
 * DDG/Brave search code in web-search.ts already requires.
 */

/**
 * Thrown by assertPublicHttpUrl instead of returning a falsy value, so callers
 * can't accidentally proceed past a rejected URL.
 */
export class PrivateNetworkTargetError extends Error {
  constructor(public readonly requestedUrl: string, public readonly detail: string) {
    super(`Refusing to fetch "${requestedUrl}": ${detail}`)
    this.name = 'PrivateNetworkTargetError'
  }
}

/** Thrown when the fetched body's content-type (header and/or sniffed bytes) isn't on the allowlist. */
export class UnsupportedContentTypeError extends Error {
  constructor(public readonly requestedUrl: string, public readonly detail: string) {
    super(`Refusing to return body of "${requestedUrl}": ${detail}`)
    this.name = 'UnsupportedContentTypeError'
  }
}

/** Resolves a hostname to its IP addresses. Injected so assertPublicHttpUrl stays unit-testable without real DNS/network access. */
export type DnsResolver = (hostname: string) => Promise<string[]>

/**
 * node:dns/promises, loaded lazily (not a static top-level import) so this module has no
 * hard Node dependency — it's reachable from assistant.ts/index.ts, which is also bundled
 * into the browser build (chat-ui), and a static `import 'node:dns/promises'` would break
 * that build even though this path only actually runs when a caller omits `dns`.
 */
async function defaultDnsResolver(hostname: string): Promise<string[]> {
  const dns = await import('node:dns/promises')
  const records = await dns.lookup(hostname, { all: true })
  return records.map((r) => r.address)
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
}

function isLiteralIpAddress(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local, includes the 169.254.169.254 cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT (100.64.0.0/10), also used for some cloud-internal services
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking (198.18.0.0/15)
  if (a >= 224) return true // multicast, reserved, broadcast
  if (a === 0) return true // "this network"
  return false
}

/** Expands an IPv6 literal (without brackets/zone) into its eight 16-bit groups, or null if it is not a valid IPv6 address. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const octets = v4[1].split('.').map(Number)
    if (octets.some((o) => o > 255)) return null
    text = `${text.slice(0, -v4[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16))
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0]
  const groups = ipv6Groups(normalized)
  // Unparseable: refuse rather than guess.
  if (!groups) return true
  const embeddedV4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0)
  if (firstFiveZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) return true // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d, which URL parsing serialises as ::ffff:7f00:1), IPv4-compatible (::a.b.c.d)
  // and NAT64 (64:ff9b::a.b.c.d) addresses carry an IPv4 target: judge that target.
  if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) return isPrivateIPv4(embeddedV4)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return isPrivateIPv4(embeddedV4)
  if ((groups[0] & 0xffc0) === 0xfe80) return true // link-local, fe80::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return true // unique local, fc00::/7
  if ((groups[0] & 0xff00) === 0xff00) return true // multicast
  return false
}

function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip)
}

/**
 * Parses `url`, rejects non-http(s) schemes / credentialed URLs / non-80/443 ports / raw IP
 * literals outright (all before any DNS call), then resolves the hostname and throws
 * PrivateNetworkTargetError if any resolved address is loopback, RFC1918 private, link-local,
 * or a well-known cloud metadata address. Must be called again on every redirect hop — a public
 * URL can 302 to a private one — which is exactly what fetchTextSafely's redirect loop below does.
 */
export async function assertPublicHttpUrl(url: string, dns: DnsResolver = defaultDnsResolver): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PrivateNetworkTargetError(url, 'not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PrivateNetworkTargetError(url, `unsupported scheme "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new PrivateNetworkTargetError(url, 'credentials in the URL are not allowed')
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new PrivateNetworkTargetError(url, `port "${parsed.port}" is not allowed (only 80/443)`)
  }

  const hostname = stripBrackets(parsed.hostname)

  if (hostname === 'localhost') {
    throw new PrivateNetworkTargetError(url, '"localhost" resolves to a loopback address')
  }

  if (isLiteralIpAddress(hostname)) {
    throw new PrivateNetworkTargetError(url, 'raw IP address targets are not allowed; a hostname is required')
  }

  const addresses = await dns(hostname)
  if (addresses.length === 0) {
    throw new PrivateNetworkTargetError(url, `could not resolve "${hostname}"`)
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new PrivateNetworkTargetError(url, `"${hostname}" resolves to private/loopback/link-local address "${address}"`)
    }
  }
}

export const MAX_REDIRECTS = 5

// Real pages routinely run tens-to-hundreds of KB of raw HTML. On the claude-cli backend, a tool
// result this large gets written by the `claude -p` subprocess itself to a temp file, and the model
// falls back to proposing a `sed`/`grep` shell command to page through it — turning a read-only
// "fetch and summarize a page" request into an unexplained shell-command approval prompt. Capping
// the returned text well below that threshold keeps fetch_url a single-step, non-shell-gated tool
// call for the vast majority of real pages.
export const MAX_FETCH_CHARS = 15_000

// Streamed-read byte ceiling: a defense against a lying/absent Content-Length header forcing a
// huge download before the char-level cap below even runs. Set generously above MAX_FETCH_CHARS
// (worst case ~4 bytes/char for non-ASCII UTF-8) rather than tightly at it, since this cap exists
// to bound worst-case download size, not to produce the user-facing truncation message — that's
// still truncateFetchedText's job below.
const DEFAULT_MAX_FETCH_BYTES = 4 * MAX_FETCH_CHARS

const DEFAULT_TIMEOUT_MS = 10_000

const FIXED_USER_AGENT = 'buildaharness-fetch-url/1.0'

const DEFAULT_ALLOWED_CONTENT_TYPES = ['text/*', 'application/json', 'application/xml', 'application/xhtml+xml', 'application/*+json']

function matchesContentTypeAllowlist(contentType: string, allowed: string[]): boolean {
  const [type] = contentType.split(';')
  const normalized = type.trim().toLowerCase()
  return allowed.some((pattern) => {
    if (pattern === normalized) return true
    if (pattern.endsWith('/*')) return normalized.startsWith(pattern.slice(0, -1))
    if (pattern.startsWith('application/*+')) return normalized.endsWith(pattern.slice('application/*'.length))
    return false
  })
}

// Common binary magic numbers — enough to catch a mislabeled binary response (e.g. a server that
// serves a PDF/image with a text/* or missing content-type) without needing a real MIME sniffer.
const BINARY_SIGNATURES: Uint8Array[] = [
  new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
  new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG
  new Uint8Array([0xff, 0xd8, 0xff]), // JPEG
  new Uint8Array([0x47, 0x49, 0x46, 0x38]), // GIF8
  new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // ZIP (also docx/xlsx/jar)
  new Uint8Array([0x1f, 0x8b]), // gzip
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // ELF
  new Uint8Array([0x4d, 0x5a]), // MZ (Windows PE)
]

function startsWithSignature(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

/**
 * Sniffs the first bytes of a response body to decide if it's text-like, independent of
 * (and as a check against) whatever the Content-Type header claims — "sniff the first bytes,
 * do not trust the header alone." Flags known binary magic numbers, plus a high ratio of
 * NUL/control bytes outside common whitespace as a generic binary signal.
 */
function looksBinary(bytes: Uint8Array): boolean {
  if (BINARY_SIGNATURES.some((sig) => startsWithSignature(bytes, sig))) return true
  const sample = bytes.subarray(0, Math.min(bytes.length, 512))
  if (sample.length === 0) return false
  let suspicious = 0
  for (const byte of sample) {
    const isCommonWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d
    if (!isCommonWhitespace && (byte === 0x00 || byte < 0x08 || (byte >= 0x0e && byte < 0x20))) suspicious++
  }
  return suspicious / sample.length > 0.1
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function readOrAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (r) => { signal.removeEventListener('abort', onAbort); resolve(r) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

async function readCappedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body
  if (!body) {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text)
    if (bytes.length <= maxBytes) return { bytes, truncated: false }
    return { bytes: bytes.subarray(0, maxBytes), truncated: true }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      // A fetch implementation that ignores the abort signal must not be able to stall the read.
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await readOrAbort(reader, signal)
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        const allowed = maxBytes - (total - value.byteLength)
        if (allowed > 0) chunks.push(value.subarray(0, allowed))
        truncated = true
        break
      }
      chunks.push(value)
    }
  } finally {
    // Cancel on truncation AND on an abort/error thrown mid-read, so the connection is released.
    if (truncated) await reader.cancel().catch(() => {})
    else void reader.cancel().catch(() => {})
  }
  return { bytes: concatUint8Arrays(chunks), truncated }
}

function truncateFetchedText(text: string): string {
  if (text.length <= MAX_FETCH_CHARS) return text
  return `${text.slice(0, MAX_FETCH_CHARS)}\n\n[... truncated at ${MAX_FETCH_CHARS} characters; the page is longer than shown here ...]`
}

export interface FetchTextSafelyOptions {
  url: string
  dns?: DnsResolver
  fetchImpl?: typeof fetch
  maxBytes?: number
  maxRedirects?: number
  allowedContentTypes?: string[]
  timeoutMs?: number
}

export interface FetchTextSafelyResult {
  text: string
  finalUrl: string
  /** True if either the streamed byte cap or the char-level cap truncated the returned text. */
  truncated: boolean
}

/**
 * Fetches `options.url`, following redirects manually (not via fetch's automatic redirect-follow)
 * so every hop gets its own assertPublicHttpUrl check — a public URL that 302s to a private
 * target is rejected mid-fetch, not silently followed. Enforces a streamed byte cap (a
 * Content-Length header can lie), a content-type allowlist (checked against both the header and
 * the sniffed body bytes), and a connect+read timeout. Sends a fixed User-Agent and nothing else
 * client-supplied — zero ambient authority, safe to run on a caller's behalf server-side.
 */
export async function fetchTextSafely(options: FetchTextSafelyOptions): Promise<FetchTextSafelyResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FETCH_BYTES
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let currentUrl = options.url
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertPublicHttpUrl(currentUrl, options.dns)

    // One timer covers the headers AND the body read: a server that sends headers and then drips
    // (or stalls) the body would otherwise hold this call open forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    let bytes: Uint8Array
    let byteTruncated: boolean
    try {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': FIXED_USER_AGENT },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        // The redirect body is never read; release the connection.
        await response.body?.cancel().catch(() => {})
        if (!location) throw new Error(`Redirect response from "${currentUrl}" had no Location header`)
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }

      ;({ bytes, truncated: byteTruncated } = await readCappedBody(response, maxBytes, controller.signal))
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Timed out fetching "${currentUrl}" after ${timeoutMs}ms`)
      throw err
    } finally {
      clearTimeout(timer)
    }
    const headerContentType = response.headers.get('content-type') ?? ''
    const headerAllowed = headerContentType !== '' && matchesContentTypeAllowlist(headerContentType, allowedContentTypes)
    if (!headerAllowed && looksBinary(bytes)) {
      throw new UnsupportedContentTypeError(
        currentUrl,
        headerContentType ? `content-type "${headerContentType}" is not text/JSON/XML-like and the body looks binary` : 'no content-type header and the body looks binary',
      )
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const finalText = truncateFetchedText(text)
    return { text: finalText, finalUrl: currentUrl, truncated: byteTruncated || finalText.length !== text.length }
  }
  throw new Error(`Too many redirects while fetching "${options.url}"`)
}
