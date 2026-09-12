import type { Context } from 'hono'
import { signFetchTag } from './web-fetch-tag'
import { getWebRateLimitConfig, grantCounter, HOUR_MS, logWebRequest } from './rate-limit'
import { subjectOf } from './web-quota-middleware'

/**
 * POST /web/grant — mints a fetchTag for a URL that didn't come from a /web/search result,
 * namely a URL the user typed verbatim in their own message. The caller (chat-ui) is trusted to
 * call this only for user-authored URLs, never for a URL sourced from tool output or model text
 * — see plans/browser_web_tools_via_proxy_plan.html's W3 section. Deliberately no different from
 * /web/search's tag in shape or TTL; the only difference is the caller's provenance guarantee.
 *
 * Rate-limited harder than /web/fetch's shared per-token quota (an open URL-signing oracle is
 * worse than an open fetch, since a tag can be replayed against /web/fetch as many times as it's
 * valid while unexpired) via its own dedicated `grantCounter` on top of the shared
 * createWebQuotaMiddleware() request/IP ceiling every /web/* route already gets.
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
  const sub = subjectOf(c)
  const env = (c.env ?? {}) as Record<string, string | undefined>
  const config = getWebRateLimitConfig(env)

  const grantResult = grantCounter.consume(`sub:${sub}`, 1, config.grantRequestsPerHour, HOUR_MS)
  if (!grantResult.allowed) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/grant', status: 429, guardRejectReason: 'grant rate limit' })
    return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(grantResult.retryAfterSeconds) })
  }

  if (!body || typeof body.url !== 'string' || !body.url.trim() || !isHttpUrl(body.url)) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/grant', status: 400 })
    return c.json({ error: 'missing or invalid url field' }, 400)
  }

  // createAuthMiddleware() already 500'd if this were missing, so it's guaranteed present here.
  const proxySecret = (env.PROXY_SECRET ?? process.env.PROXY_SECRET) as string
  const fetchTag = await signFetchTag(body.url, proxySecret)
  logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/grant', status: 200 })
  return c.json({ fetchTag })
}
