import { braveSearch, executeWebTool, type AssistantConfig, type DnsResolver, type WebSearchResult } from '@buildaharness/aielia'
import { isUserAuthoredUrl, rememberUserUrls } from './user-urls'

/**
 * Public sentinel IP (203.0.113.1, RFC 5737 TEST-NET-3 — never routable) handed to
 * `fetchTextSafely`'s SSRF guard (`assertPublicHttpUrl`) in proxy mode so it's a no-op: the guard
 * treats an empty resolver result as "unresolvable" and rejects, but a plain browser tab has no
 * DNS API to give it a real answer anyway, and the real check already happens server-side in the
 * proxy's own `/web/fetch` handler (which does have real DNS). Chosen over threading a
 * `skipLocalGuard` flag through `web-fetch-core.ts` — see
 * the internal plan's W5 section for why the sentinel is the smaller
 * change. Non-http(s) schemes, credentialed URLs, literal IPs, and "localhost" are all still
 * rejected before this resolver is ever consulted, since those checks run first in
 * `assertPublicHttpUrl`.
 */
const PROXY_MODE_DNS_SENTINEL: DnsResolver = async () => ['203.0.113.1']

/** Shape of a proxy `/web/*` error response — `{ error: string }` on every non-2xx path in web-search.ts/web-fetch.ts/web-grant.ts. */
interface ProxyWebErrorBody {
  error?: string
}

/**
 * Builds the webTools context for `webBackend: 'proxy'` in a plain browser tab (never called on
 * desktop, which keeps the Tauri path regardless of `webBackend` — see createWebTools below).
 * Routes web_search/fetch_url through `${config.proxyUrl}/web/search` and `/web/fetch`, reusing
 * the same bearer `authToken` already wired for `/llm/chat`. A search result's proxy-minted
 * `fetchTag` (the signed-URL capability from W3) is stashed by URL so a subsequent `fetch_url`
 * call for that exact URL can present it back; a URL the model didn't get from search (e.g. one
 * the user pasted) has no stashed tag, so it goes through `/web/grant` instead — the same
 * provenance split chat-ui's caller is trusted to preserve per web-grant.ts's doc comment.
 */
export function createProxyWebTools(config: AssistantConfig): { search: (query: string) => Promise<WebSearchResult[]>; fetchImpl: typeof fetch; dns: DnsResolver } {
  const fetchTagsByUrl = new Map<string, string>()

  async function callProxy<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${config.proxyUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.authToken}` },
      body: JSON.stringify(body),
    })
    const json = (await response.json().catch(() => undefined)) as (T & ProxyWebErrorBody) | undefined
    if (!response.ok) throw new Error(json?.error ?? `proxy request to ${path} failed with HTTP ${response.status}`)
    return json as T
  }

  const search = async (query: string): Promise<WebSearchResult[]> => {
    const { results } = await callProxy<{ results: (WebSearchResult & { fetchTag: string })[] }>('/web/search', {
      query,
      // Sent fresh on every call, never persisted proxy-side — see web-search.ts's braveApiKey
      // request field.
      braveApiKey: config.braveApiKey,
    })
    for (const r of results) fetchTagsByUrl.set(r.url, r.fetchTag)
    return results.map(({ title, url, snippet }) => ({ title, url, snippet }))
  }

  // Ignores the incoming Request's own method/body — web-tools.ts's fetchTextSafely always calls
  // this as a plain GET of `url`, so the only input worth reading is the target URL itself.
  // Redirects are already resolved server-side (web-fetch.ts calls fetchTextSafely internally),
  // so the synthetic Response below is never a 3xx and fetchTextSafely's own redirect loop never
  // sees a second iteration.
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let fetchTag = fetchTagsByUrl.get(url)
    if (!fetchTag) {
      // /web/grant is for a URL the user typed. A URL the model invented or copied out of fetched
      // page text must not become a fetch capability, or the tag scheme is an open relay again.
      if (!isUserAuthoredUrl(url)) throw new Error('fetch_url refused: that URL was neither returned by web_search nor typed by the user')
      fetchTag = (await callProxy<{ fetchTag: string }>('/web/grant', { url })).fetchTag
    }
    const { text } = await callProxy<{ text: string; finalUrl: string; truncated: boolean }>('/web/fetch', { url, fetchTag })
    return new Response(text, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  return { search, fetchImpl, dns: PROXY_MODE_DNS_SENTINEL }
}

/**
 * Builds the webTools context (search, fetchImpl, dns) for web_search/fetch_url.
 *
 * fetchImpl: Brave's Search API (and fetch_url's arbitrary target) aren't CORS-enabled for
 * arbitrary browser origins, so a plain `fetch()` from inside this app fails outright with
 * "Failed to fetch" (verified live). On desktop this is fixed by routing through
 * @tauri-apps/plugin-http's fetch — a real HTTP request made from Rust, no CORS involved.
 * Scoped via capabilities/default.json's `http:default` entry to any http(s) URL (originally
 * just api.search.brave.com, which left fetch_url's arbitrary targets CORS-blocked on desktop
 * — widened once fetch_url needed real page fetches too); the real gate against SSRF is the
 * DNS-checked `assertPublicHttpUrl` guard below, not this scope. A plain browser tab has no
 * equivalent escape hatch and is left on native fetch.
 *
 * A plain browser tab with `webBackend: 'proxy'` sidesteps the CORS problem entirely by never
 * fetching the search backend or the target URL directly — see createProxyWebTools above.
 * `webBackend` is otherwise ignored on desktop, which always keeps the Tauri path below.
 *
 * dns: fetch_url's SSRF guard (web-tools.ts's assertPublicHttpUrl) defaults to
 * `node:dns/promises`, which doesn't exist in any webview or browser tab — without an
 * override it throws on every fetch_url call, not just an occasional failure. Desktop gets
 * a real resolver (tauriDnsResolver, backed by the dns_lookup Tauri command); a plain
 * browser tab has no DNS API available at all and is left on the (always-failing) default,
 * same "capability absent, not a crash" degradation as everywhere else this app can't fully
 * support something — the failure is caught by assistant.ts's tool dispatch and reported to
 * the model as an error result, never a crashed turn.
 */
export async function createWebTools(config: AssistantConfig, isDesktop: boolean): Promise<{ search: (query: string) => Promise<WebSearchResult[]>; fetchImpl?: typeof fetch; dns?: DnsResolver }> {
  if (!isDesktop && config.webBackend === 'proxy') return createProxyWebTools(config)
  const fetchImpl = isDesktop ? (await import('@tauri-apps/plugin-http')).fetch : undefined
  const dns = isDesktop ? (await import('./tauri-dns-resolver')).tauriDnsResolver : undefined
  const search = (query: string) => braveSearch(query, config.braveApiKey ?? '', { fetchImpl })
  return { search, fetchImpl, dns }
}

/**
 * Reads a web page as text through a webTools context (the one createWebTools or createProxyWebTools builds): the address the writer typed is
 * remembered as theirs (so it may be fetched), then the page goes through fetch_url's address guard. One implementation for Write on every host.
 */
export function pageReader(ctx: { search: (query: string) => Promise<WebSearchResult[]>; fetchImpl?: typeof fetch; dns?: DnsResolver }): (url: string) => Promise<string> {
  return async (url) => {
    rememberUserUrls(url)
    return (await executeWebTool({ search: ctx.search, fetchImpl: ctx.fetchImpl, dns: ctx.dns }, 'fetch_url', { url })).text
  }
}
