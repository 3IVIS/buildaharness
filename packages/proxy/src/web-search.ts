import type { Context } from 'hono'
import { signFetchTag } from './web-fetch-tag'
import { braveDailyCounter, DAY_MS, getWebRateLimitConfig, logWebRequest } from './rate-limit'
import { subjectOf } from './web-quota-middleware'

/**
 * Server-side web search for POST /web/search.
 *
 * Ported from packages/personal-assistant/src/web-search-provider.ts (kept dependency-free
 * here rather than imported, so the Worker bundle doesn't pick up an unrelated workspace
 * package) — see that file's doc comment for why DDG's HTML endpoint is parsed with plain
 * regexes instead of a DOM parser, and why DDG (no API key) is the default backend.
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

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ')
  return withoutTags.replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** DDG's HTML endpoint wraps result links through a redirect: /l/?uddg=<encoded-real-url>&... — unwrap it back to the real target. */
function extractDdgResultUrl(rawHref: string): string {
  try {
    const parsed = new URL(rawHref, 'https://html.duckduckgo.com')
    const uddg = parsed.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : parsed.toString()
  } catch {
    return rawHref
  }
}

const TITLE_LINK_RE = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

function parseDdgResults(html: string, maxResults: number): WebSearchResult[] {
  const titles: { href: string; title: string }[] = []
  for (const match of html.matchAll(TITLE_LINK_RE)) {
    titles.push({ href: match[1], title: decodeHtmlEntities(stripHtml(match[2])) })
  }
  const snippets = [...html.matchAll(SNIPPET_RE)].map((match) => decodeHtmlEntities(stripHtml(match[1])))

  const results: WebSearchResult[] = []
  for (let i = 0; i < titles.length && results.length < maxResults; i++) {
    if (!titles[i].title) continue
    results.push({ title: titles[i].title, url: extractDdgResultUrl(titles[i].href), snippet: snippets[i] ?? '' })
  }
  return results
}

const DEFAULT_MAX_RESULTS = 5

async function duckDuckGoSearch(query: string): Promise<WebSearchResult[]> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  })
  if (!response.ok) throw new Error(`ddg upstream error ${response.status}`)
  const html = await response.text()
  return parseDdgResults(html, DEFAULT_MAX_RESULTS)
}

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
  backend?: string
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
  if (body.backend !== undefined && body.backend !== 'ddg' && body.backend !== 'brave') {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 400 })
    return c.json({ error: 'invalid backend' }, 400)
  }

  const env = (c.env ?? {}) as Record<string, string | undefined>
  const backend = body.backend ?? env.WEB_SEARCH_BACKEND ?? process.env.WEB_SEARCH_BACKEND ?? 'ddg'
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
  if (backend === 'brave' && !requestBraveKey) {
    const config = getWebRateLimitConfig(env)
    const braveResult = braveDailyCounter.consume('global', 1, config.braveDailyCeiling, DAY_MS)
    if (!braveResult.allowed) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 429, guardRejectReason: 'brave daily ceiling' })
      return c.json({ error: 'brave search daily ceiling reached' }, 429, { 'Retry-After': String(braveResult.retryAfterSeconds) })
    }
  }

  try {
    const results =
      backend === 'brave'
        ? await (async () => {
            if (!braveApiKey) return null
            return braveSearch(query, braveApiKey)
          })()
        : await duckDuckGoSearch(query)
    if (results === null) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/search', status: 500 })
      return c.json({ error: 'server misconfigured' }, 500)
    }

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
