import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HOUR_MS, clientIp, type ClientIpOptions, getWebRateLimitConfig, ipRequestCounter, requestCounter } from './rate-limit'

interface JwtPayloadHolder {
  payload?: { sub?: string }
}

/** Reads the JWT `sub` set by createAuthMiddleware(), which always runs before this middleware on /web/*. */
export function subjectOf(c: Context): string {
  const holder = c.get('jwtPayload') as JwtPayloadHolder | undefined
  return holder?.payload?.sub ?? 'unknown'
}

/**
 * Which client-identity sources to trust. On the Cloudflare Worker (no Node `incoming` binding)
 * cf-connecting-ip is set by Cloudflare itself. On Node it is client-controlled, so only the TCP
 * peer address is used unless the operator sets TRUST_PROXY_HEADERS (a reverse proxy that
 * overwrites x-forwarded-for / x-real-ip sits in front).
 */
export function clientIpOptions(c: Context, env: Record<string, string | undefined>): ClientIpOptions {
  const node = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const trustProxy = /^(1|true|yes|on)$/i.test(env.TRUST_PROXY_HEADERS ?? process.env.TRUST_PROXY_HEADERS ?? '')
  return {
    trustCloudflare: !node || trustProxy,
    trustForwarded: trustProxy,
    remoteAddress: node?.socket?.remoteAddress,
  }
}

/**
 * Pre-flight quota gate shared by every /web/* route: a per-token (JWT `sub`) requests/hour
 * ceiling, plus a stricter per-IP requests/hour ceiling layered in front of it. The per-IP layer
 * exists for the hosted /try build, where every anonymous visitor shares one token (so the
 * per-sub limit alone would be a single global ceiling shared by all of them) — see the plan's W4
 * scope and its "shared Brave key on hosted /try" risk note.
 *
 * Route-specific quotas (bytes/hour + concurrency for /web/fetch, per-host throttle for
 * /web/fetch, the Brave daily ceiling for /web/search, the heavier /web/grant-specific limit) are
 * layered on top of this by each route handler, since they need per-route cost accounting this
 * shared middleware has no visibility into.
 */
export function createWebQuotaMiddleware() {
  return createMiddleware(async (c, next) => {
    const env = (c.env ?? {}) as Record<string, string | undefined>
    const config = getWebRateLimitConfig(env)
    const sub = subjectOf(c)
    const ip = clientIp(c.req.raw.headers, clientIpOptions(c, env))

    const subResult = requestCounter.consume(`sub:${sub}`, 1, config.requestsPerHour, HOUR_MS)
    if (!subResult.allowed) {
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(subResult.retryAfterSeconds) })
    }

    const ipResult = ipRequestCounter.consume(`ip:${ip}`, 1, config.ipRequestsPerHour, HOUR_MS)
    if (!ipResult.allowed) {
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(ipResult.retryAfterSeconds) })
    }

    await next()
  })
}
