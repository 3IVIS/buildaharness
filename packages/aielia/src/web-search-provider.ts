import type { WebSearchResult } from './web-tools.js'

/**
 * Ready-made implementation of WebToolsContext.search, for callers who don't already have a
 * search API to inject (see web-tools.ts's doc comment — search has no default there, since a
 * caller may prefer their own paid/authenticated backend).
 *
 * `braveSearch` queries the Brave Search API (requires an API key) — the only backend this app
 * offers. A prior DuckDuckGo-HTML-scraping backend was removed: DuckDuckGo's HTML endpoint
 * resets the TLS connection outright for any non-browser client (curl, Node, Cloudflare
 * Workers all hit the same wall, confirmed live during
 * plans/browser_web_tools_via_proxy_plan.html's W8) — a TLS-fingerprint/IP-reputation block
 * beneath the HTTP layer, not something a request header or retry can work around.
 */

const DEFAULT_MAX_RESULTS = 5

export interface BraveSearchOptions {
  maxResults?: number
  fetchImpl?: typeof fetch
}

interface BraveSearchApiResponse {
  web?: {
    results?: { title?: string; url?: string; description?: string }[]
  }
}

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/**
 * Queries the Brave Search API and returns a bounded, parsed result list. Matches
 * WebToolsContext['search']'s signature. Requires a Brave Search API key — see
 * https://api.search.brave.com/app/keys — passed as `apiKey`, sent as the
 * `X-Subscription-Token` header Brave's API expects.
 */
export async function braveSearch(query: string, apiKey: string, options: BraveSearchOptions = {}): Promise<WebSearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS

  const url = new URL(BRAVE_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(maxResults))

  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  if (!response.ok) throw new Error(`Brave web search failed with status ${response.status}`)

  const body = (await response.json()) as BraveSearchApiResponse
  const results = body.web?.results ?? []
  return results.slice(0, maxResults).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }))
}
