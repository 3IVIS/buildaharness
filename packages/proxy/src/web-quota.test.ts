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
    return addresses.map((address) => ({ address, family: 4 })) as never
  })
}

async function fetchUrl(url: string, token: string): Promise<Response> {
  const tag = await signFetchTag(url, TEST_SECRET)
  return app.request('/web/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, fetchTag: tag }),
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

    const first = await fetchUrl('http://public.example/', token)
    expect(first.status).toBe(200)

    const second = await fetchUrl('http://public.example/', token)
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

    const firstPromise = fetchUrl('http://public.example/', token)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await fetchUrl('http://public.example/', token)
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

    const first = await fetchUrl('http://public.example/page-a', token)
    expect(first.status).toBe(200)
    const second = await fetchUrl('http://public.example/page-b', token)
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
    const search = (query: string) =>
      app.request('/web/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, backend: 'brave' }),
      })
    expect((await search('first')).status).toBe(200)
    const second = await search('second')
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
