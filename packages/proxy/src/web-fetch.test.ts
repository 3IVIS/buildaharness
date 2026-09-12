// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from './index'
import { signFetchTag } from './web-fetch-tag'
import { resetWebRateLimitState } from './rate-limit'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    throw new Error('unexpected real DNS lookup in test — configure dnsLookupMock first')
  }),
}))

const TEST_SECRET = 'test-proxy-secret-12345'

async function getAuthToken(): Promise<string> {
  const res = await app.request('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: TEST_SECRET }),
  })
  const json = (await res.json()) as { token: string }
  return json.token
}

async function mockDns(map: Record<string, string[]>): Promise<void> {
  const dns = await import('node:dns/promises')
  vi.mocked(dns.lookup).mockImplementation(async (hostname: string) => {
    const addresses = map[hostname as string]
    if (!addresses) throw new Error(`no fake DNS entry for "${hostname}"`)
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never
  })
}

async function fetchBody(url: string, token: string, fetchTag?: string): Promise<Response> {
  const tag = fetchTag ?? (await signFetchTag(url, TEST_SECRET))
  return app.request('/web/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, fetchTag: tag }),
  })
}

beforeEach(() => {
  process.env.PROXY_SECRET = TEST_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  resetWebRateLimitState()
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetWebRateLimitState()
})

describe('POST /web/fetch', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/web/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://public.example/' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed body (missing url)', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('', token)
    expect(res.status).toBe(400)
  })

  it('returns 403 when no fetchTag is provided', async () => {
    const token = await getAuthToken()
    const res = await app.request('/web/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: 'http://public.example/' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 403 for a forged fetchTag', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('http://public.example/', token, '9999999999.not-a-real-signature')
    expect(res.status).toBe(403)
  })

  it('returns 403 when the fetchTag was signed for a different URL', async () => {
    const token = await getAuthToken()
    const tagForOtherUrl = await signFetchTag('http://other.example/', TEST_SECRET)
    const res = await fetchBody('http://public.example/', token, tagForOtherUrl)
    expect(res.status).toBe(403)
  })

  it('returns 403 for an expired fetchTag', async () => {
    const token = await getAuthToken()
    const expiredTag = await signFetchTag('http://public.example/', TEST_SECRET, -1)
    const res = await fetchBody('http://public.example/', token, expiredTag)
    expect(res.status).toBe(403)
  })

  it('returns 400 for a raw IP literal target', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('http://93.184.216.34/', token)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a credentialed URL', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('http://user:pass@example.com/', token)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a disallowed port', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('http://example.com:22/', token)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a non-http(s) scheme', async () => {
    const token = await getAuthToken()
    const res = await fetchBody('file:///etc/passwd', token)
    expect(res.status).toBe(400)
  })

  it('returns 400 when the hostname resolves to a private address', async () => {
    const token = await getAuthToken()
    await mockDns({ 'internal.example': ['10.0.0.5'] })
    const res = await fetchBody('http://internal.example/', token)
    expect(res.status).toBe(400)
  })

  it('returns 400 when a redirect points at a private target', async () => {
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.0.0.1'] })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://internal.example/secret' } })),
    )
    const res = await fetchBody('http://public.example/', token)
    expect(res.status).toBe(400)
  })

  it('returns 415 when the body looks binary regardless of content-type', async () => {
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(pdfBytes, { status: 200 })))
    const res = await fetchBody('http://public.example/', token)
    expect(res.status).toBe(415)
  })

  it('returns 502 after too many redirects', async () => {
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://public.example/' } })),
    )
    const res = await fetchBody('http://public.example/', token)
    expect(res.status).toBe(502)
  })

  it('returns 200 with the fetched text and final URL for a public target', async () => {
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('page body text', { status: 200 })))
    const res = await fetchBody('http://public.example/', token)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ text: 'page body text', finalUrl: 'http://public.example/', truncated: false })
  })
})
