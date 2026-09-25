/**
 * Deterministic local fixture web server for the eval arms (AL1e of plans/adaptive_layer_selection_plan.html).
 *
 * `web_search`/`fetch_url` need a network; the benchmark must never touch the live one
 * (cross-cutting rule 3). This builds a real `WebToolsContext` whose `fetchImpl` answers from a
 * task's `webPages` in-process — so the production `fetchTextSafely` path (SSRF guard, redirects,
 * content-type allowlist, byte cap) and the trust-tagging that wraps a fetched page in
 * `<untrusted_external_content>` run unchanged, and only the socket is replaced. Unknown URLs
 * answer 404 (a dead end, like a real missing page). The fake DNS returns a public documentation
 * address so the guard passes for every fixture host.
 */
import type { WebToolsContext, WebSearchResult } from '../src/web-tools.js'
import type { TaskSpec } from './corpus/schema.js'

type Page = TaskSpec['webPages'][number]

const normalize = (u: string): string => {
  try {
    const p = new URL(u)
    return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '') || '/'}${p.search}`
  } catch {
    return u
  }
}

const titleOf = (p: Page): string => /<title>([^<]*)<\/title>/i.exec(p.content)?.[1]?.trim() || new URL(p.url).pathname

export interface FixtureWeb {
  ctx: WebToolsContext
  /** Every URL requested through `fetch_url`, in order — lets a test prove the mechanism reached the page. */
  fetched: string[]
}

export function makeFixtureWeb(pages: readonly Page[]): FixtureWeb {
  const byUrl = new Map(pages.map((p) => [normalize(p.url), p]))
  const fetched: string[] = []
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    fetched.push(url)
    const page = byUrl.get(normalize(url))
    if (!page) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(page.content, { status: page.status, headers: { 'content-type': page.contentType } })
  }) as typeof fetch
  const search = async (query: string): Promise<WebSearchResult[]> => {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
    return pages
      .filter((p) => p.status === 200)
      .filter((p) => words.some((w) => p.content.toLowerCase().includes(w) || p.url.toLowerCase().includes(w)))
      .map((p) => ({ title: titleOf(p), url: p.url, snippet: p.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) }))
  }
  return { ctx: { search, fetchImpl, dns: async () => ['93.184.216.34'] }, fetched }
}
