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
  if (a === 0) return true // "this network"
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fe80:')) return true // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // unique local, fc00::/7
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return isPrivateIPv4(mapped[1])
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

async function readCappedBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
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
      const { done, value } = await reader.read()
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
    if (truncated) await reader.cancel().catch(() => {})
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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': FIXED_USER_AGENT },
      })
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Timed out fetching "${currentUrl}" after ${timeoutMs}ms`)
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Redirect response from "${currentUrl}" had no Location header`)
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    const { bytes, truncated: byteTruncated } = await readCappedBody(response, maxBytes)
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
