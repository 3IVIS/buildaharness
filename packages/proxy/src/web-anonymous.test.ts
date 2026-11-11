// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import app from './index'
import { resetWebRateLimitState } from './rate-limit'
import { signToken } from './auth'

const SECRET = 'test-proxy-secret-12345'
const HOSTED = 'https://myaielia.com'

beforeEach(() => {
  resetWebRateLimitState()
  process.env.PROXY_SECRET = SECRET
  process.env.ALLOWED_ORIGIN = HOSTED
  process.env.ANONYMOUS_WEB_ORIGINS = HOSTED
  delete process.env.BRAVE_API_KEY
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
  delete process.env.ANONYMOUS_WEB_ORIGINS
  delete process.env.WEB_PER_IP_REQUESTS_PER_HOUR
})

/** A /web/search call with no query, so a request that gets past auth and the quota is answered 400 before anything leaves the proxy. */
function search(headers: Record<string, string>) {
  return app.request('/web/search', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({}) })
}

describe('/web/* without a token, from an allowed origin', () => {
  it('lets the hosted origin in with no Authorization header, or an empty bearer', async () => {
    expect((await search({ Origin: HOSTED, 'cf-connecting-ip': '1.1.1.1' })).status).toBe(400)
    expect((await search({ Origin: HOSTED, Authorization: 'Bearer ', 'cf-connecting-ip': '1.1.1.2' })).status).toBe(400)
  })

  it('refuses another origin, no origin, and any origin when the setting is off', async () => {
    expect((await search({ Origin: 'https://evil.example', 'cf-connecting-ip': '2.2.2.1' })).status).toBe(401)
    expect((await search({ 'cf-connecting-ip': '2.2.2.2' })).status).toBe(401)
    delete process.env.ANONYMOUS_WEB_ORIGINS
    expect((await search({ Origin: HOSTED, 'cf-connecting-ip': '2.2.2.3' })).status).toBe(401)
  })

  it('matches the origin exactly, not by prefix', async () => {
    expect((await search({ Origin: `${HOSTED}.evil.example`, 'cf-connecting-ip': '3.3.3.1' })).status).toBe(401)
    expect((await search({ Origin: 'http://myaielia.com', 'cf-connecting-ip': '3.3.3.2' })).status).toBe(401)
  })

  it('always checks a token that is sent: a wrong one is refused even from the allowed origin, a good one works from anywhere', async () => {
    expect((await search({ Origin: HOSTED, Authorization: 'Bearer not-a-real-token', 'cf-connecting-ip': '4.4.4.1' })).status).toBe(401)
    const good = await signToken(SECRET)
    expect((await search({ Origin: 'http://localhost:5173', Authorization: `Bearer ${good}`, 'cf-connecting-ip': '4.4.4.2' })).status).toBe(400)
    expect((await search({ Authorization: `Bearer ${good}`, 'cf-connecting-ip': '4.4.4.3' })).status).toBe(400)
  })

  it('covers /web/fetch and /web/grant too, but never /llm/chat', async () => {
    const post = (path: string) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: HOSTED, 'cf-connecting-ip': '5.5.5.1' }, body: JSON.stringify({}) })
    expect((await post('/web/fetch')).status).toBe(400)
    expect((await post('/web/grant')).status).toBe(400)
    expect((await post('/llm/chat')).status).toBe(401)
  })

  it('still reports a misconfigured server when the secret is missing', async () => {
    delete process.env.PROXY_SECRET
    expect((await search({ Origin: HOSTED, 'cf-connecting-ip': '6.6.6.1' })).status).toBe(500)
  })

  it('counts each anonymous visitor on their own address: one visitor reaching the limit does not stop another', async () => {
    process.env.WEB_PER_IP_REQUESTS_PER_HOUR = '2'
    const as = (ip: string) => search({ Origin: HOSTED, 'cf-connecting-ip': ip })
    expect((await as('7.7.7.1')).status).toBe(400)
    expect((await as('7.7.7.1')).status).toBe(400)
    expect((await as('7.7.7.1')).status).toBe(429)
    expect((await as('7.7.7.2')).status).toBe(400)
  })
})
