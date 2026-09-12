import type { Context } from 'hono'
import { signFetchTag } from './web-fetch-tag'
import { braveDailyCounter, DAY_MS, getWebRateLimitConfig, logWebRequest } from './rate-limit'
import { subjectOf } from './web-quota-middleware'

/**
 * Server-side web search for POST /web/search. Brave Search is the only backend — a prior
 * DuckDuckGo-HTML-scraping backend was removed: DuckDuckGo's HTML endpoint resets the TLS
 * connection outright for any non-browser client (curl, Node, Cloudflare Workers all hit the
 * same wall, confirmed live during plans/browser_web_tools_via_proxy_plan.html's W8) — a
 * TLS-fingerprint/IP-reputation block beneath the HTTP layer, not something a request header or
 * retry can work around.
 */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface TaggedWebSearchResult extends WebSearchResult {
  /** Signed-URL capability tag — see web-fetch-tag.ts. Only a fetch of this exact URL, presented with this tag, is accepted by /web/fetch. */
  fetchTag: string
}

const DEFAULT_MAX_RESULTS = 5

interface BraveSearchApiResponse {
  web?: {
    results?: { title?: string; url?: string; description?: string }[]
  }
}

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

async function braveSearch(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(DEFAULT_MAX_RESULTS))

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  if (!response.ok) throw new Error(`brave upstream error ${response.status}`)

  const body = (await response.json()) as BraveSearchApiResponse
  const results = body.web?.results ?? []
  return results.slice(0, DEFAULT_MAX_RESULTS).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }))
}

interface WebSearchRequestBody {
  query?: string
  /** Caller-supplied Brave key (chat-ui's config.braveApiKey, sent fresh on every /web/search
   * call — see App.tsx's createProxyWebTools). Forwarded straight to Brave and never persisted
   * or logged here. Takes priority over BRAVE_API_KEY below, which exists only for a self-hosted
   * operator who wants one shared key for their own deployment. */
  braveApiKey?: string
}

export async function handleWebSearch(c: Context): Promise<Response> {
  const body = await c.req.json<WebSearchRequestBody>().catch(() => null)
  const sub = subjectOf(c)
  if (!body || typeof body.query !== 'string' || !body.query.trim()) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 400 })
    return c.json({ error: 'missing query field' }, 400)
  }

  const env = (c.env ?? {}) as Record<string, string | undefined>
  // createAuthMiddleware() already 500'd if this were missing, so it's guaranteed present here.
  const proxySecret = (env.PROXY_SECRET ?? process.env.PROXY_SECRET) as string
  const query = body.query

  const requestBraveKey = typeof body.braveApiKey === 'string' && body.braveApiKey.trim() ? body.braveApiKey : undefined
  const sharedBraveKey = env.BRAVE_API_KEY ?? process.env.BRAVE_API_KEY
  const braveApiKey = requestBraveKey ?? sharedBraveKey

  // Global daily ceiling on Brave calls (not per-sub or per-IP): protects the one *shared*
  // BRAVE_API_KEY (the self-hosted-operator fallback above) from being run up or banned by
  // aggregate traffic — see the plan's W4 scope + risks. Doesn't apply when the caller brought
  // their own key: that key is theirs, on their own Brave account's quota, not this deployment's.
  if (!requestBraveKey) {
    const config = getWebRateLimitConfig(env)
    const braveResult = braveDailyCounter.consume('global', 1, config.braveDailyCeiling, DAY_MS)
    if (!braveResult.allowed) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 429, guardRejectReason: 'brave daily ceiling' })
      return c.json({ error: 'brave search daily ceiling reached' }, 429, { 'Retry-After': String(braveResult.retryAfterSeconds) })
    }
  }

  if (!braveApiKey) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 500 })
    return c.json({ error: 'server misconfigured' }, 500)
  }

  try {
    const results = await braveSearch(query, braveApiKey)
    const tagged: TaggedWebSearchResult[] = await Promise.all(
      results.map(async (r) => ({ ...r, fetchTag: await signFetchTag(r.url, proxySecret) })),
    )
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 200 })
    return c.json({ results: tagged })
  } catch {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 502 })
    return c.json({ error: 'upstream search failed' }, 502)
  }
}
