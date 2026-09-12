// @vitest-environment node
//
// Single regression surface for "is the /web/* fetch proxy still safe": consolidates the
// guard (W2 SSRF hardening on /web/fetch), the fetchTag capability model (W3 /web/search +
// /web/grant issuance, /web/fetch enforcement), and the quota/observability layer (W4) into
// one file that drives the real Hono app with a mocked upstream fetch + DNS. Each describe
// block below used to be its own file (web-fetch.test.ts, web-search.test.ts,
// web-grant.test.ts, web-quota.test.ts); they're merged here so one file is the answer to
// "did I break the fetch proxy's safety properties" instead of four. web-fetch-tag.test.ts
// (pure sign/verify unit tests, no HTTP layer) and rate-limit.test.ts (pure counter unit
// tests) stay separate — they test isolated modules, not the route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from './index'
import { signFetchTag, verifyFetchTag } from './web-fetch-tag'
import { resetWebRateLimitState } from './rate-limit'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    throw new Error('unexpected real DNS lookup in test — configure mockDns first')
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

async function search(token: string, query: string, backend?: string): Promise<Response> {
  return app.request('/web/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, backend }),
  })
}

async function grant(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return app.request('/web/grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders },
    body: JSON.stringify({ url }),
  })
}

const RATE_LIMIT_ENV_VARS = [
  'WEB_REQUESTS_PER_HOUR',
  'WEB_BYTES_PER_HOUR',
  'WEB_MAX_CONCURRENT_FETCHES',
  'WEB_HOST_REQUESTS_PER_HOUR',
  'WEB_PER_IP_REQUESTS_PER_HOUR',
  'WEB_BRAVE_DAILY_CEILING',
  'WEB_GRANT_REQUESTS_PER_HOUR',
  'WEB_GUARD_REJECT_ALERT_THRESHOLD',
  'BRAVE_API_KEY',
  'WEB_SEARCH_BACKEND',
]

beforeEach(() => {
  process.env.PROXY_SECRET = TEST_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  resetWebRateLimitState()
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
  for (const name of RATE_LIMIT_ENV_VARS) delete process.env[name]
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetWebRateLimitState()
})

describe('POST /web/fetch — SSRF guard (W2)', () => {
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

describe('POST /web/search — backends + fetchTag issuance (W1/W3)', () => {
  const DDG_HTML = `
    <a class="result__a" href="https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Example Title</a>
    <a class="result__snippet">An example snippet.</a>
  `
  const BRAVE_JSON = {
    web: {
      results: [{ title: 'Brave Title', url: 'https://example.com/brave', description: 'A brave snippet.' }],
    },
  }

  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed body (missing query)', async () => {
    const token = await getAuthToken()
    const res = await search(token, undefined as unknown as string)
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid backend', async () => {
    const token = await getAuthToken()
    const res = await search(token, 'test', 'yahoo')
    expect(res.status).toBe(400)
  })

  it('runs the DDG backend by default and returns parsed results with a fetchTag', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DDG_HTML, { status: 200 })))

    const res = await search(token, 'test query')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: { title: string; url: string; snippet: string; fetchTag: string }[] }
    expect(json.results).toHaveLength(1)
    expect(json.results[0]).toMatchObject({ title: 'Example Title', url: 'https://example.com/', snippet: 'An example snippet.' })
    expect(json.results[0].fetchTag).toMatch(/^\d+\.[A-Za-z0-9_-]+$/)
  })

  it('runs the Brave backend when requested and a key is configured', async () => {
    process.env.BRAVE_API_KEY = 'test-brave-key'
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(BRAVE_JSON), { status: 200 })))

    const res = await search(token, 'test query', 'brave')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: { title: string; url: string; snippet: string; fetchTag: string }[] }
    expect(json.results).toHaveLength(1)
    expect(json.results[0]).toMatchObject({ title: 'Brave Title', url: 'https://example.com/brave', snippet: 'A brave snippet.' })
    expect(json.results[0].fetchTag).toMatch(/^\d+\.[A-Za-z0-9_-]+$/)
  })

  it('issues a fetchTag that /web/fetch accepts for that exact URL', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DDG_HTML, { status: 200 })))

    const searchRes = await search(token, 'test query')
    const { results } = (await searchRes.json()) as { results: { url: string; fetchTag: string }[] }
    const { url, fetchTag } = results[0]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('page text', { status: 200 })))
    await mockDns({ 'example.com': ['93.184.216.34'] })

    const fetchRes = await fetchBody(url, token, fetchTag)
    expect(fetchRes.status).toBe(200)
  })

  it('returns 500 when backend=brave and no key is configured', async () => {
    const token = await getAuthToken()
    const res = await search(token, 'test query', 'brave')
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toEqual({ error: 'server misconfigured' })
  })

  it('returns 502 when the upstream search errors', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    const res = await search(token, 'test query')
    expect(res.status).toBe(502)
  })
})

describe('POST /web/grant — user-pasted-URL capability (W3)', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/web/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://user-pasted.example/' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a missing url field', async () => {
    const token = await getAuthToken()
    const res = await grant(undefined as unknown as string, token)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a non-http(s) url', async () => {
    const token = await getAuthToken()
    const res = await grant('file:///etc/passwd', token)
    expect(res.status).toBe(400)
  })

  it('issues a fetchTag that verifies for the exact URL granted', async () => {
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/page'
    const res = await grant(url, token)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { fetchTag: string }
    expect(await verifyFetchTag(url, json.fetchTag, TEST_SECRET)).toBe(true)
    expect(await verifyFetchTag('http://other.example/', json.fetchTag, TEST_SECRET)).toBe(false)
  })
})

describe('/web/* quotas + observability (W4)', () => {
  it('returns 429 with Retry-After once the per-sub requests/hour ceiling is hit', async () => {
    process.env.WEB_REQUESTS_PER_HOUR = '2'
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/'
    expect((await grant(url, token)).status).toBe(200)
    expect((await grant(url, token)).status).toBe(200)
    const third = await grant(url, token)
    expect(third.status).toBe(429)
    expect(third.headers.get('Retry-After')).toBeTruthy()
  })

  it('rejects a fetch once the per-sub bytes/hour ceiling is already exhausted', async () => {
    process.env.WEB_BYTES_PER_HOUR = '5'
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('AAAAA', { status: 200 })))

    const first = await fetchBody('http://public.example/', token)
    expect(first.status).toBe(200)

    const second = await fetchBody('http://public.example/', token)
    expect(second.status).toBe(429)
    const json = await second.json()
    expect(json).toMatchObject({ error: 'bytes/hour quota exceeded' })
  })

  it('rejects the (cap+1)th concurrent fetch for the same sub', async () => {
    process.env.WEB_MAX_CONCURRENT_FETCHES = '1'
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    let resolveFetch: ((r: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))

    const firstPromise = fetchBody('http://public.example/', token)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await fetchBody('http://public.example/', token)
    expect(second.status).toBe(429)

    resolveFetch?.(new Response('ok', { status: 200 }))
    const first = await firstPromise
    expect(first.status).toBe(200)
  })

  it('trips the per-destination-host throttle on repeated same-host calls', async () => {
    process.env.WEB_HOST_REQUESTS_PER_HOUR = '1'
    const token = await getAuthToken()
    await mockDns({ 'public.example': ['93.184.216.34'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('body text', { status: 200 })))

    const first = await fetchBody('http://public.example/page-a', token)
    expect(first.status).toBe(200)
    const second = await fetchBody('http://public.example/page-b', token)
    expect(second.status).toBe(429)
    const json = await second.json()
    expect(json).toMatchObject({ error: 'destination host rate limit exceeded' })
  })

  it('applies a stricter per-IP ceiling in front of the per-sub one', async () => {
    process.env.WEB_PER_IP_REQUESTS_PER_HOUR = '1'
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/'
    const ipHeaders = { 'x-forwarded-for': '203.0.113.5' }
    const first = await grant(url, token, ipHeaders)
    expect(first.status).toBe(200)
    const second = await grant(url, token, ipHeaders)
    expect(second.status).toBe(429)
  })

  it('enforces a global daily ceiling on Brave calls, independent of sub/IP', async () => {
    process.env.WEB_BRAVE_DAILY_CEILING = '1'
    process.env.BRAVE_API_KEY = 'test-brave-key'
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })))
    expect((await search(token, 'first', 'brave')).status).toBe(200)
    const second = await search(token, 'second', 'brave')
    expect(second.status).toBe(429)
    const json = await second.json()
    expect(json).toMatchObject({ error: 'brave search daily ceiling reached' })
  })

  it('rate-limits /web/grant more tightly than the shared per-sub ceiling', async () => {
    process.env.WEB_REQUESTS_PER_HOUR = '1000'
    process.env.WEB_GRANT_REQUESTS_PER_HOUR = '1'
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/'
    expect((await grant(url, token)).status).toBe(200)
    const second = await grant(url, token)
    expect(second.status).toBe(429)
  })

  it('emits a structured log line per call with no query/url/body content', async () => {
    const logLines: string[] = []
    const original = console.log
    console.log = (msg: unknown) => {
      logLines.push(String(msg))
    }
    try {
      const token = await getAuthToken()
      await grant('http://user-pasted.example/secret-path', token)
    } finally {
      console.log = original
    }

    const entries: Record<string, unknown>[] = logLines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null)

    const grantEntry = entries.find((e) => e.route === '/web/grant')
    expect(grantEntry).toBeDefined()
    expect(grantEntry).toMatchObject({ route: '/web/grant', status: 200 })
    expect(grantEntry?.sub).toBeDefined()
    expect(grantEntry?.ts).toBeDefined()
    expect(grantEntry?.query).toBeUndefined()
    expect(grantEntry?.url).toBeUndefined()
    expect(grantEntry?.body).toBeUndefined()
    expect(JSON.stringify(grantEntry)).not.toContain('secret-path')
  })

  it('resets a tripped requests/hour ceiling after the window elapses', async () => {
    vi.useFakeTimers()
    process.env.WEB_REQUESTS_PER_HOUR = '1'
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/'
    expect((await grant(url, token)).status).toBe(200)
    expect((await grant(url, token)).status).toBe(429)

    vi.advanceTimersByTime(60 * 60 * 1000 + 1000)
    const freshToken = await getAuthToken()
    expect((await grant(url, freshToken)).status).toBe(200)
  })

  it('allows a burst of sequential calls under a generous limit', async () => {
    process.env.WEB_GRANT_REQUESTS_PER_HOUR = '50'
    const token = await getAuthToken()
    for (let i = 0; i < 20; i++) {
      const res = await grant(`http://user-pasted.example/page-${i}`, token)
      expect(res.status).toBe(200)
    }
  })
})
