import { describe, it, expect } from 'vitest'
import { executeWebTool, assertPublicHttpUrl, PrivateNetworkTargetError, type WebToolsContext, type DnsResolver } from './web-tools.js'

function makeCtx(overrides: Partial<WebToolsContext> = {}): WebToolsContext {
  return {
    async search() {
      return []
    },
    ...overrides,
  }
}

function fakeDns(map: Record<string, string[]>): DnsResolver {
  return async (hostname: string) => map[hostname] ?? []
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers })
}

describe('executeWebTool', () => {
  it('web_search formats results as title/url/snippet blocks', async () => {
    const ctx = makeCtx({
      async search(query) {
        expect(query).toBe('capital of france')
        return [{ title: 'Paris', url: 'https://example.com/paris', snippet: 'Paris is the capital of France.' }]
      },
    })

    const result = await executeWebTool(ctx, 'web_search', { query: 'capital of france' })
    expect(result.text).toContain('Paris')
    expect(result.text).toContain('https://example.com/paris')
  })

  it('web_search reports no results plainly', async () => {
    const result = await executeWebTool(makeCtx(), 'web_search', { query: 'nothing' })
    expect(result.text).toBe('No results found.')
  })

  it('fetch_url returns the response body text using the injected fetch implementation', async () => {
    const ctx = makeCtx({
      fetchImpl: (async () => textResponse('page body text')) as typeof fetch,
      dns: fakeDns({ 'example.com': ['93.184.216.34'] }),
    })

    const result = await executeWebTool(ctx, 'fetch_url', { url: 'https://example.com' })
    expect(result.text).toBe('page body text')
  })

  it('throws for an unknown tool name', async () => {
    await expect(executeWebTool(makeCtx(), 'not_a_tool', {})).rejects.toThrow('Unknown web tool')
  })
})

describe('assertPublicHttpUrl (SSRF guard)', () => {
  it('rejects a non-http(s) scheme outright', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('rejects a loopback literal IPv4 address with no DNS call', async () => {
    const dns = fakeDns({})
    await expect(assertPublicHttpUrl('http://127.0.0.1/', dns)).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('rejects a loopback IPv6 literal address', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('rejects "localhost" without a DNS call', async () => {
    await expect(assertPublicHttpUrl('http://localhost:8080/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('rejects a hostname that resolves to a loopback address, via an injected fake DnsResolver', async () => {
    await expect(assertPublicHttpUrl('http://sneaky.example/', fakeDns({ 'sneaky.example': ['127.0.0.1'] }))).rejects.toThrow(
      PrivateNetworkTargetError,
    )
  })

  it('rejects RFC1918 private targets: 10.x, 172.16-31.x, 192.168.x, but allows 172.x outside that range', async () => {
    await expect(assertPublicHttpUrl('http://a.example/', fakeDns({ 'a.example': ['10.0.0.5'] }))).rejects.toThrow(
      PrivateNetworkTargetError,
    )
    await expect(assertPublicHttpUrl('http://b.example/', fakeDns({ 'b.example': ['172.20.0.5'] }))).rejects.toThrow(
      PrivateNetworkTargetError,
    )
    await expect(assertPublicHttpUrl('http://c.example/', fakeDns({ 'c.example': ['192.168.1.5'] }))).rejects.toThrow(
      PrivateNetworkTargetError,
    )
    await expect(assertPublicHttpUrl('http://d.example/', fakeDns({ 'd.example': ['172.32.0.5'] }))).resolves.toBeUndefined()
  })

  it('rejects a link-local target, including the 169.254.169.254 cloud metadata address', async () => {
    await expect(
      assertPublicHttpUrl('http://metadata.example/', fakeDns({ 'metadata.example': ['169.254.169.254'] })),
    ).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('allows a hostname that resolves only to a public address', async () => {
    await expect(
      assertPublicHttpUrl('http://public.example/', fakeDns({ 'public.example': ['93.184.216.34'] })),
    ).resolves.toBeUndefined()
  })

  it('rejects a hostname that fails to resolve to any address', async () => {
    await expect(assertPublicHttpUrl('http://nowhere.example/', fakeDns({}))).rejects.toThrow(PrivateNetworkTargetError)
  })
})

describe('fetch_url SSRF protection via executeWebTool', () => {
  it('rejects a loopback target before any network call, via an injected fake DnsResolver', async () => {
    const fetchImpl = (async () => textResponse('should never be reached')) as typeof fetch
    const ctx = makeCtx({ fetchImpl, dns: fakeDns({}) })

    await expect(executeWebTool(ctx, 'fetch_url', { url: 'http://127.0.0.1/admin' })).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('re-validates after a redirect — a public URL that 302s to a private target is rejected, not followed', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return textResponse('', { status: 302, headers: { location: 'http://internal.example/secret' } })
    }) as typeof fetch
    const ctx = makeCtx({
      fetchImpl,
      dns: fakeDns({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.0.0.1'] }),
    })

    await expect(executeWebTool(ctx, 'fetch_url', { url: 'http://public.example/' })).rejects.toThrow(PrivateNetworkTargetError)
    expect(calls).toBe(1)
  })

  it('follows a redirect to another public target', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      if (calls === 1) return textResponse('', { status: 302, headers: { location: 'http://public2.example/' } })
      return textResponse('final page')
    }) as typeof fetch
    const ctx = makeCtx({
      fetchImpl,
      dns: fakeDns({ 'public.example': ['93.184.216.34'], 'public2.example': ['93.184.216.35'] }),
    })

    const result = await executeWebTool(ctx, 'fetch_url', { url: 'http://public.example/' })
    expect(result.text).toBe('final page')
    expect(calls).toBe(2)
  })
})
