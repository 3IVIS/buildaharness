import type { WebSearchResult } from './web-tools.js'

/**
 * A ready-made implementation of WebToolsContext.search, for callers who don't already have a
 * search API to inject (see web-tools.ts's doc comment — search has no default there, since a
 * caller may prefer their own paid/authenticated backend). Queries DuckDuckGo's HTML endpoint
 * (no API key needed — the same provider `adapter/crewai_adapter.py`'s `ddgs`-backed `web_search`
 * uses, for the same reason), and parses the top results out of its markup with plain regexes
 * (no DOM parser dependency, keeping this browser-safe and dependency-free).
 */

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

export interface DuckDuckGoSearchOptions {
  maxResults?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_MAX_RESULTS = 5

/** Queries DuckDuckGo's HTML endpoint and returns a bounded, parsed result list. Matches WebToolsContext['search']'s signature. */
export async function duckDuckGoSearch(query: string, options: DuckDuckGoSearchOptions = {}): Promise<WebSearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS

  const response = await fetchImpl('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  })
  if (!response.ok) throw new Error(`Web search failed with status ${response.status}`)

  const html = await response.text()
  return parseDdgResults(html, maxResults)
}
