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
})
