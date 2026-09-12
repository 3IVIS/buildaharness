/**
 * Server-side safe-fetch core for POST /web/fetch: the SSRF guard (assertPublicHttpUrl) plus a
 * redirect-following, byte-capped, content-type-checked fetch loop (fetchTextSafely).
 *
 * Ported from packages/personal-assistant/src/web-fetch-core.ts (same reasoning as
 * web-search.ts's doc comment: this package's only workspace-dependency-free build target is the
 * Worker bundle, and personal-assistant's only `exports` entry is its whole `dist/index.js`
 * bundle — nodemailer, the MCP SDK, the CLI — which this repo's proxy CI job and this plan's own
 * suggested gate script don't build before typechecking/testing packages/proxy). Keep the two
 * guards in sync by hand if either changes.
 *
 * DNS-rebinding note: this fetches with the platform's real DNS (node:dns/promises) and does not
 * pin the outbound TCP connection to the resolved+validated address — a real IP-pinning fetch
 * agent needs a live socket to test against, which isn't available in this sandbox, so it's
 * deferred rather than shipped untested. The behavioral guard below (scheme/credentials/port/
 * literal-IP/private-range rejection, re-checked per redirect hop) is what's actually exercised
 * by the vitest suite and is the bulk of the exploitable surface; the residual TOCTOU window
 * between resolve and connect is accepted for v1 the same way this plan already accepts it for
 * the Cloudflare Worker deploy target (which can't pin sockets at all).
 */

export class PrivateNetworkTargetError extends Error {
  constructor(public readonly requestedUrl: string, public readonly detail: string) {
    super(`Refusing to fetch "${requestedUrl}": ${detail}`)
    this.name = 'PrivateNetworkTargetError'
  }
}

export class UnsupportedContentTypeError extends Error {
  constructor(public readonly requestedUrl: string, public readonly detail: string) {
    super(`Refusing to return body of "${requestedUrl}": ${detail}`)
    this.name = 'UnsupportedContentTypeError'
  }
}

export type DnsResolver = (hostname: string) => Promise<string[]>

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
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return isPrivateIPv4(mapped[1])
  return false
}

function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip)
}

/** Rejects non-http(s) schemes, credentialed URLs, non-80/443 ports, and raw IP literals before any DNS call, then rejects a hostname that resolves to a private/loopback/link-local address. */
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
export const MAX_FETCH_CHARS = 15_000
const DEFAULT_MAX_FETCH_BYTES = 4 * MAX_FETCH_CHARS
const DEFAULT_TIMEOUT_MS = 10_000
const FIXED_USER_AGENT = 'buildaharness-proxy-fetch/1.0'
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

const BINARY_SIGNATURES: Uint8Array[] = [
  new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
  new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG
  new Uint8Array([0xff, 0xd8, 0xff]), // JPEG
  new Uint8Array([0x47, 0x49, 0x46, 0x38]), // GIF8
  new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // ZIP
  new Uint8Array([0x1f, 0x8b]), // gzip
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // ELF
  new Uint8Array([0x4d, 0x5a]), // MZ
]

function startsWithSignature(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

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
  truncated: boolean
}

/**
 * Fetches `options.url` with zero ambient authority — a fixed User-Agent, no forwarded client
 * cookies/Authorization/headers/IP. Follows redirects manually so assertPublicHttpUrl re-runs on
 * every hop; enforces a streamed byte cap (a Content-Length header can lie), a content-type
 * allowlist checked against both the header and the sniffed body bytes, and a connect+read
 * timeout.
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
