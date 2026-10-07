import { describe, it, expect } from 'vitest'
import {
  assertPublicHttpUrl,
  fetchTextSafely,
  PrivateNetworkTargetError,
  UnsupportedContentTypeError,
  type DnsResolver,
} from './web-fetch-core.js'

// The address-family SSRF guard table (loopback/RFC1918/link-local/metadata literals and
// resolved-address rejection, public-address acceptance) is already covered by
// web-tools.test.ts's "assertPublicHttpUrl (SSRF guard)" describe block, which exercises the
// same function through web-tools.ts's re-export. This file covers the W2 hardening additions:
// credentialed URLs, non-80/443 ports, raw-IP-literal rejection, and fetchTextSafely's
// content-type / byte-cap / timeout behavior.

function fakeDns(map: Record<string, string[]>): DnsResolver {
  return async (hostname: string) => map[hostname] ?? []
}

describe('assertPublicHttpUrl — W2 hardening', () => {
  it('rejects a URL carrying credentials', async () => {
    await expect(assertPublicHttpUrl('http://user:pass@example.com/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('rejects a non-standard port', async () => {
    await expect(assertPublicHttpUrl('http://example.com:22/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('allows explicit default ports 80 and 443', async () => {
    await expect(assertPublicHttpUrl('http://example.com:80/', fakeDns({ 'example.com': ['93.184.216.34'] }))).resolves.toBeUndefined()
    await expect(assertPublicHttpUrl('https://example.com:443/', fakeDns({ 'example.com': ['93.184.216.34'] }))).resolves.toBeUndefined()
  })

  it('rejects a raw IP literal target even when the address is public — a hostname is required', async () => {
    await expect(assertPublicHttpUrl('http://93.184.216.34/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })
})

describe('assertPublicHttpUrl — resolved-address range coverage', () => {
  const rejected = [
    '::ffff:7f00:1', // IPv4-mapped loopback in the hex form URL/DNS libraries emit
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe', // mapped 169.254.169.254
    '::7f00:1', // IPv4-compatible loopback
    '64:ff9b::7f00:1', // NAT64 loopback
    'fe90::1', // link-local fe80::/10 beyond fe80:
    'febf::1',
    'fd12::1',
    'ff02::1', // multicast
    '100.64.0.1', // carrier-grade NAT
    '198.18.0.1',
    '224.0.0.1',
    '0.0.0.0',
  ]
  for (const address of rejected) {
    it(`rejects a hostname resolving to ${address}`, async () => {
      await expect(assertPublicHttpUrl('http://h.example/', fakeDns({ 'h.example': [address] }))).rejects.toThrow(PrivateNetworkTargetError)
    })
  }
  it('still accepts public IPv4 and IPv6 resolutions', async () => {
    await expect(assertPublicHttpUrl('http://h.example/', fakeDns({ 'h.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] }))).resolves.toBeUndefined()
    await expect(assertPublicHttpUrl('http://h.example/', fakeDns({ 'h.example': ['::ffff:5db8:d822'] }))).resolves.toBeUndefined()
  })
})

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers })
}

describe('fetchTextSafely', () => {
  const publicDns = fakeDns({ 'public.example': ['93.184.216.34'], 'public2.example': ['93.184.216.35'] })

  it('returns the body text and final URL for a public target', async () => {
    const fetchImpl = (async () => textResponse('hello world')) as typeof fetch
    const result = await fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl })
    expect(result).toEqual({ text: 'hello world', finalUrl: 'http://public.example/', truncated: false })
  })

  it('rejects a response whose body looks binary regardless of a missing/wrong content-type header', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    const fetchImpl = (async () => new Response(pdfBytes, { status: 200 })) as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl })).rejects.toThrow(UnsupportedContentTypeError)
  })

  it('accepts a JSON body even when mislabeled, since sniffing shows it is text-like', async () => {
    const fetchImpl = (async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as typeof fetch
    const result = await fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl })
    expect(result.text).toBe('{"ok":true}')
  })

  it('truncates the body when it exceeds the byte cap, marking the result truncated', async () => {
    const fetchImpl = (async () => textResponse('y'.repeat(1000))) as typeof fetch
    const result = await fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl, maxBytes: 100 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(1000)
  })

  it('re-checks the guard on redirect and rejects a hop to a private target', async () => {
    const dns = fakeDns({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.0.0.1'] })
    const fetchImpl = (async () => textResponse('', { status: 302, headers: { location: 'http://internal.example/secret' } })) as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns, fetchImpl })).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('asks the fetch implementation not to follow redirects itself (the Tauri http plugin ignores redirect: manual)', async () => {
    let seen: Record<string, unknown> | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init as Record<string, unknown>
      return textResponse('hello')
    }) as unknown as typeof fetch
    await fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl })
    expect(seen?.redirect).toBe('manual')
    expect(seen?.maxRedirections).toBe(0)
  })

  it('gives up after too many redirects', async () => {
    const fetchImpl = (async () => textResponse('', { status: 302, headers: { location: 'http://public.example/' } })) as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl, maxRedirects: 2 })).rejects.toThrow('Too many redirects')
  })

  it('times out a hung request', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl, timeoutMs: 20 })).rejects.toThrow('Timed out fetching')
  })

  it('times out a body that stalls after the headers arrived', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('partial')) } })
    const fetchImpl = (async () => new Response(stalled, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns: publicDns, fetchImpl, timeoutMs: 50 })).rejects.toThrow(/Timed out/)
  })

  it('cannot be bypassed by an unrecognized options field (e.g. a future skipLocalGuard sentinel) — the guard always runs', async () => {
    const internalDns = fakeDns({ 'internal.example': ['10.0.0.1'] })
    const fetchImpl = (async () => textResponse('should never be reached')) as typeof fetch
    const optionsWithSentinel = { url: 'http://internal.example/', dns: internalDns, fetchImpl, skipLocalGuard: true } as Parameters<
      typeof fetchTextSafely
    >[0]
    await expect(fetchTextSafely(optionsWithSentinel)).rejects.toThrow(PrivateNetworkTargetError)
  })
})
