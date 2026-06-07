import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from './index'

// We test using Hono's built-in app.request() to avoid starting a real HTTP server.

const TEST_SECRET = 'test-proxy-secret-12345'

beforeEach(() => {
  process.env.PROXY_SECRET = TEST_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  // Clear API keys so /llm/chat returns 500 (api key not configured)
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  vi.restoreAllMocks()
})

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ status: 'ok' })
  })
})

describe('POST /auth/token', () => {
  it('returns a JWT when the correct secret is provided', async () => {
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TEST_SECRET }),
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { token: string }
    expect(typeof json.token).toBe('string')
    // JWT should have 3 parts
    expect(json.token.split('.').length).toBe(3)
  })

  it('returns 401 when wrong secret is provided', async () => {
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong-secret' }),
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toEqual({ error: 'unauthorized' })
  })

  it('returns 401 when no secret is provided', async () => {
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it('returns 500 when PROXY_SECRET env is not set', async () => {
    delete process.env.PROXY_SECRET
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TEST_SECRET }),
    })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toEqual({ error: 'server misconfigured' })
  })
})

describe('POST /llm/chat', () => {
  async function getAuthToken(): Promise<string> {
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TEST_SECRET }),
    })
    const json = await res.json() as { token: string }
    return json.token
  }

  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid bearer token', async () => {
    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid.token.here',
      },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when model field is missing', async () => {
    const token = await getAuthToken()
    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ error: 'missing model field' })
  })

  it('returns 400 for unsupported model', async () => {
    const token = await getAuthToken()
    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'unknown-model-xyz', messages: [] }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ error: 'unsupported_model' })
  })

  it('returns 500 when API key is not configured', async () => {
    const token = await getAuthToken()
    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [] }),
    })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toEqual({ error: 'api key not configured' })
  })

  it('forwards request to anthropic when API key is configured', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    const token = await getAuthToken()

    // Mock global fetch to avoid real HTTP call
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(mockStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ))

    const res = await app.request('/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
  })
})

describe('CORS headers', () => {
  it('includes CORS headers in response', async () => {
    const res = await app.request('/health', {
      headers: { 'Origin': 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
    // CORS middleware should have run
    const allowOrigin = res.headers.get('Access-Control-Allow-Origin')
    expect(allowOrigin).toBeTruthy()
  })
})
