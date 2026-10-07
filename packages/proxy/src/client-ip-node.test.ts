// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import app from './index'
import { resetWebRateLimitState } from './rate-limit'

beforeEach(() => {
  process.env.PROXY_SECRET = 's3cret'
  process.env.AUTH_FAILS_PER_HOUR = '2'
  resetWebRateLimitState()
})
afterEach(() => {
  delete process.env.PROXY_SECRET
  delete process.env.AUTH_FAILS_PER_HOUR
  delete process.env.TRUST_PROXY_HEADERS
})

async function withServer(fn: (post: (xff: string) => Promise<number>) => Promise<void>): Promise<void> {
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as { port: number }).port
  const post = async (xff: string) =>
    (await fetch(`http://127.0.0.1:${port}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ secret: 'wrong' }),
    })).status
  try {
    await fn(post)
  } finally {
    server.close()
  }
}

it('on Node a spoofed x-forwarded-for does not give each attempt a fresh throttle bucket', async () => {
  await withServer(async (post) => {
    expect(await post('1.1.1.1')).toBe(401)
    expect(await post('2.2.2.2')).toBe(401)
    expect(await post('3.3.3.3')).toBe(429)
  })
})

it('with TRUST_PROXY_HEADERS the forwarded address is the bucket key', async () => {
  process.env.TRUST_PROXY_HEADERS = '1'
  await withServer(async (post) => {
    expect(await post('1.1.1.1')).toBe(401)
    expect(await post('2.2.2.2')).toBe(401)
    expect(await post('3.3.3.3')).toBe(401)
  })
})
