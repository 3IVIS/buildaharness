// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from './index'
import { resetWebRateLimitState } from './rate-limit'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    throw new Error('unexpected real DNS lookup in test — configure the mock first')
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

const DDG_HTML = `
  <a class="result__a" href="https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Example Title</a>
  <a class="result__snippet">An example snippet.</a>
`

const BRAVE_JSON = {
  web: {
    results: [{ title: 'Brave Title', url: 'https://example.com/brave', description: 'A brave snippet.' }],
  },
}

beforeEach(() => {
  process.env.PROXY_SECRET = TEST_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  delete process.env.BRAVE_API_KEY
  delete process.env.WEB_SEARCH_BACKEND
  resetWebRateLimitState()
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
  delete process.env.BRAVE_API_KEY
  delete process.env.WEB_SEARCH_BACKEND
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetWebRateLimitState()
})

describe('POST /web/search', () => {
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
    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid backend', async () => {
    const token = await getAuthToken()
    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test', backend: 'yahoo' }),
    })
    expect(res.status).toBe(400)
  })

  it('runs the DDG backend by default and returns parsed results with a fetchTag', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DDG_HTML, { status: 200 })))

    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test query' }),
    })
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

    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test query', backend: 'brave' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: { title: string; url: string; snippet: string; fetchTag: string }[] }
    expect(json.results).toHaveLength(1)
    expect(json.results[0]).toMatchObject({ title: 'Brave Title', url: 'https://example.com/brave', snippet: 'A brave snippet.' })
    expect(json.results[0].fetchTag).toMatch(/^\d+\.[A-Za-z0-9_-]+$/)
  })

  it('issues a fetchTag that /web/fetch accepts for that exact URL', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DDG_HTML, { status: 200 })))

    const searchRes = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test query' }),
    })
    const { results } = (await searchRes.json()) as { results: { url: string; fetchTag: string }[] }
    const { url, fetchTag } = results[0]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('page text', { status: 200 })))
    const dns = await import('node:dns/promises')
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)

    const fetchRes = await app.request('/web/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url, fetchTag }),
    })
    expect(fetchRes.status).toBe(200)
  })

  it('returns 500 when backend=brave and no key is configured', async () => {
    const token = await getAuthToken()
    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test query', backend: 'brave' }),
    })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toEqual({ error: 'server misconfigured' })
  })

  it('returns 502 when the upstream search errors', async () => {
    const token = await getAuthToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    const res = await app.request('/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'test query' }),
    })
    expect(res.status).toBe(502)
  })
})
