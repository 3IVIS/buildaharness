// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import app from './index'
import { verifyFetchTag } from './web-fetch-tag'

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

beforeEach(() => {
  process.env.PROXY_SECRET = TEST_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
})

afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.ALLOWED_ORIGIN
})

describe('POST /web/grant', () => {
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
    const res = await app.request('/web/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a non-http(s) url', async () => {
    const token = await getAuthToken()
    const res = await app.request('/web/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    })
    expect(res.status).toBe(400)
  })

  it('issues a fetchTag that verifies for the exact URL granted', async () => {
    const token = await getAuthToken()
    const url = 'http://user-pasted.example/page'
    const res = await app.request('/web/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { fetchTag: string }
    expect(await verifyFetchTag(url, json.fetchTag, TEST_SECRET)).toBe(true)
    expect(await verifyFetchTag('http://other.example/', json.fetchTag, TEST_SECRET)).toBe(false)
  })
})
