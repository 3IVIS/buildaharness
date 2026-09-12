import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from './fixtures'

/**
 * W7 of plans/browser_web_tools_via_proxy_plan.html: one browser-e2e scenario proving
 * `webBackend: 'proxy'` works end-to-end in a real browser — a scripted turn does `web_search`
 * then `fetch_url`, both routed through a real HTTP stub standing in for `@buildaharness/proxy`,
 * and the final reply (built from the fetched page text) renders.
 *
 * Unlike the scripted LLM client (seamed via `window.__BAH_E2E__`, see fixtures.ts),
 * `createWebTools`'s proxy path (App.tsx) is not seamed — it makes real `fetch` calls to
 * `config.proxyUrl`. So this spec starts a real Node HTTP server before opening the page and
 * points `proxyUrl` at it, rather than stubbing `window.fetch` the way the jsdom seam test
 * (`App.web-proxy.e2e-seam.test.tsx`) does — the point of the browser-e2e lane is to exercise the
 * real network path a plain browser tab actually takes.
 *
 * Non-blocking: this spec (like the rest of the browser-e2e lane) cannot run in the buildaharness
 * dev container (no Chromium). It runs on a dev machine (`npm run test:e2e` in packages/chat-ui)
 * or in CI, once that lane is wired as a required check.
 */

const AUTH_TOKEN = 'test-bearer-token'
const RESULT_URL = 'https://example.com/page'

interface RecordedCall {
  path: string
  authHeader: string | null
  body: unknown
}

function startStubProxy(): { server: Server; url: string; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const server = createServer((req, res) => {
    // The real fetch calls send Content-Type + Authorization headers cross-origin, both
    // "not simple" — a real browser preflights with OPTIONS before the actual POST.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      const body = raw ? JSON.parse(raw) : undefined
      const path = req.url ?? ''
      calls.push({ path, authHeader: req.headers.authorization ?? null, body })

      res.setHeader('Content-Type', 'application/json')
      if (path === '/web/search') {
        res.writeHead(200)
        res.end(JSON.stringify({ results: [{ title: 'Example', url: RESULT_URL, snippet: 'an example page', fetchTag: 'signed-tag-abc' }] }))
        return
      }
      if (path === '/web/fetch') {
        res.writeHead(200)
        res.end(JSON.stringify({ text: 'the page says hello', finalUrl: RESULT_URL, truncated: false }))
        return
      }
      res.writeHead(404)
      res.end(JSON.stringify({ error: `unexpected proxy call to ${path}` }))
    })
  })
  return { server, url: '', calls }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

test.describe('web tools via proxy (W7)', () => {
  let stub: ReturnType<typeof startStubProxy>

  test.beforeEach(async () => {
    stub = startStubProxy()
    stub.url = await listen(stub.server)
  })

  test.afterEach(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  })

  test('web_search then fetch_url route through the proxy and the fetched text reaches the reply', async ({ chat }) => {
    const page = await chat({
      oneLoopMode: 'disabled',
      config: { enableWeb: true, webBackend: 'proxy', proxyUrl: stub.url, authToken: AUTH_TOKEN, braveApiKey: 'test-brave-key' },
      script: {
        responses: [
          { content: '', toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'buildaharness' } }] },
          { content: '', toolCalls: [{ id: 't2', name: 'fetch_url', input: { url: RESULT_URL } }] },
          'The page says hello.',
        ],
        streamChunks: ['The page says hello.'],
      },
    })

    await page.sendMessage('search for buildaharness and read the top result')

    await expect(page.lastAssistantBubble()).toHaveText(/The page says hello\./)

    const searchCall = stub.calls.find((c) => c.path === '/web/search')
    expect(searchCall?.authHeader).toBe(`Bearer ${AUTH_TOKEN}`)
    expect(searchCall?.body).toEqual({ query: 'buildaharness', braveApiKey: 'test-brave-key' })

    const fetchCall = stub.calls.find((c) => c.path === '/web/fetch')
    expect(fetchCall?.authHeader).toBe(`Bearer ${AUTH_TOKEN}`)
    expect(fetchCall?.body).toEqual({ url: RESULT_URL, fetchTag: 'signed-tag-abc' })
  })
})
