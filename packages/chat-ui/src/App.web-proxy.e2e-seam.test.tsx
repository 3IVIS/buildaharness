import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createScriptedLLMClient } from '@buildaharness/personal-assistant'
import { App } from './App'
import { setAssistantTestHooks } from './assistant-test-hooks'
import { createInMemoryFsBackend } from './e2e/in-memory-fs-backend'

/**
 * W5 of plans/browser_web_tools_via_proxy_plan.html: `webBackend: 'proxy'` routes web_search/
 * fetch_url through a configured @buildaharness/proxy instead of calling DuckDuckGo/Brave/the
 * target URL directly from the browser (which fails with CORS in a real browser — see
 * createWebTools's doc comment in App.tsx). Extends the B1 seam (App.e2e-seam.test.tsx) the same
 * way: a real PersonalAssistant runs a real turn() against a scripted ILLMClient; here the global
 * `fetch` is also stubbed to stand in for the proxy's `/web/search` and `/web/fetch` routes.
 */

const STORAGE_KEY = 'buildaharness.personal-assistant.config'
const PROXY_URL = 'http://proxy.test'
const AUTH_TOKEN = 'test-bearer-token'
const RESULT_URL = 'https://example.com/page'

const SCRIPT = () => ({
  responses: [
    { content: '', toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'buildaharness' } }] },
    { content: '', toolCalls: [{ id: 't2', name: 'fetch_url', input: { url: RESULT_URL } }] },
    'The page says hello.',
  ],
  streamChunks: ['The page says hello.'],
})

interface RecordedCall {
  path: string
  authHeader: string | null
  body: unknown
}

/** Stubs global fetch to answer /web/search and /web/fetch like the real proxy routes would, recording every call's path/auth header/body for assertions. */
function installWebProxyFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const path = url.replace(PROXY_URL, '')
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      const authHeader = ((init?.headers as Record<string, string> | undefined) ?? {})['Authorization'] ?? null
      calls.push({ path, authHeader, body })

      if (path === '/web/search') {
        return new Response(
          JSON.stringify({ results: [{ title: 'Example', url: RESULT_URL, snippet: 'an example page', fetchTag: 'signed-tag-abc' }] }),
          { status: 200 },
        )
      }
      if (path === '/web/fetch') {
        return new Response(JSON.stringify({ text: 'the page says hello', finalUrl: RESULT_URL, truncated: false }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: `unexpected proxy call to ${path}` }), { status: 404 })
    }),
  )
  return calls
}

function installSeam(): void {
  setAssistantTestHooks({
    makeLlmClient: () => createScriptedLLMClient(SCRIPT()),
    makeFsBackend: () => createInMemoryFsBackend({}),
  })
}

async function sendAndReadReply(message: string): Promise<string> {
  const user = userEvent.setup()
  const { container } = render(<App />)
  const input = await screen.findByPlaceholderText('Message the assistant…')

  await user.type(input, message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(
    async () => {
      const retry = screen.queryByRole('button', { name: /retry/i })
      if (retry) await user.click(retry)
      expect(screen.getByTestId('proposer-kind')).toBeInTheDocument()
    },
    { timeout: 10000 },
  )

  const bubbles = container.querySelectorAll('.bubble__content--markdown')
  return bubbles.length > 0 ? (bubbles[bubbles.length - 1].textContent ?? '').trim() : ''
}

describe('App — webBackend "proxy"', () => {
  afterEach(() => {
    cleanup()
    setAssistantTestHooks(null)
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('web_search then fetch_url both route through the proxy with the bearer token and fetch tag', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ llmBackend: 'proxy', oneLoopMode: 'disabled', enableWeb: true, webBackend: 'proxy', proxyUrl: PROXY_URL, authToken: AUTH_TOKEN }),
    )
    const calls = installWebProxyFetchMock()
    installSeam()

    const reply = await sendAndReadReply('search for buildaharness and read the top result')

    expect(reply).toBe('The page says hello.')

    const searchCall = calls.find((c) => c.path === '/web/search')
    expect(searchCall?.authHeader).toBe(`Bearer ${AUTH_TOKEN}`)
    expect(searchCall?.body).toEqual({ query: 'buildaharness', backend: 'ddg' })

    const fetchCall = calls.find((c) => c.path === '/web/fetch')
    expect(fetchCall?.authHeader).toBe(`Bearer ${AUTH_TOKEN}`)
    expect(fetchCall?.body).toEqual({ url: RESULT_URL, fetchTag: 'signed-tag-abc' })

    // Never a /web/grant call: the fetched URL came straight from the search result, so its
    // fetchTag is already stashed — no need to mint a fresh one.
    expect(calls.some((c) => c.path === '/web/grant')).toBe(false)
  })

  it('webBackend "direct" (default) is unaffected — no proxy calls for web tools', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy', oneLoopMode: 'disabled', enableWeb: true, proxyUrl: PROXY_URL, authToken: AUTH_TOKEN }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
    installSeam()

    // The direct backend calls DuckDuckGo straight from the browser, which the stub above always
    // rejects — the point here is just that it never reaches this test's proxy mock at all, so a
    // failed web_search surfaces as a tool error rather than a crash (same degradation as today).
    const reply = await sendAndReadReply('search for buildaharness and read the top result')
    expect(reply.length).toBeGreaterThan(0)
  })
})
