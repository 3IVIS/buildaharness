import type { Context } from 'hono'
import { signFetchTag } from './web-fetch-tag'

/**
 * POST /web/grant — mints a fetchTag for a URL that didn't come from a /web/search result,
 * namely a URL the user typed verbatim in their own message. The caller (chat-ui) is trusted to
 * call this only for user-authored URLs, never for a URL sourced from tool output or model text
 * — see plans/browser_web_tools_via_proxy_plan.html's W3 section. Deliberately no different from
 * /web/search's tag in shape or TTL; the only difference is the caller's provenance guarantee.
 *
 * Heavier rate-limiting than /web/fetch is called for here (an open URL-signing oracle is worse
 * than an open fetch, since a tag can be replayed against /web/fetch as many times as it's
 * valid) — deferred to W4, which adds the shared per-token quota layer for all of /web/*.
 */

interface WebGrantRequestBody {
  url?: string
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function handleWebGrant(c: Context): Promise<Response> {
  const body = await c.req.json<WebGrantRequestBody>().catch(() => null)
  if (!body || typeof body.url !== 'string' || !body.url.trim() || !isHttpUrl(body.url)) {
    return c.json({ error: 'missing or invalid url field' }, 400)
  }

  const env = (c.env ?? {}) as Record<string, string | undefined>
  // createAuthMiddleware() already 500'd if this were missing, so it's guaranteed present here.
  const proxySecret = (env.PROXY_SECRET ?? process.env.PROXY_SECRET) as string
  const fetchTag = await signFetchTag(body.url, proxySecret)
  return c.json({ fetchTag })
}
