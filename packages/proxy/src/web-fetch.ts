import type { Context } from 'hono'
import { fetchTextSafely, PrivateNetworkTargetError, UnsupportedContentTypeError } from './web-fetch-core'
import { verifyFetchTag } from './web-fetch-tag'
import { byteCounter, fetchConcurrency, getWebRateLimitConfig, hostCounter, HOUR_MS, logWebRequest, recordGuardRejection } from './rate-limit'
import { subjectOf } from './web-quota-middleware'

interface WebFetchRequestBody {
  url?: string
  fetchTag?: string
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export async function handleWebFetch(c: Context): Promise<Response> {
  const body = await c.req.json<WebFetchRequestBody>().catch(() => null)
  const sub = subjectOf(c)
  const env = (c.env ?? {}) as Record<string, string | undefined>
  const config = getWebRateLimitConfig(env)
  const host = body?.url ? hostOf(body.url) : undefined

  if (!body || typeof body.url !== 'string' || !body.url.trim()) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', status: 400 })
    return c.json({ error: 'missing url field' }, 400)
  }

  // createAuthMiddleware() already 500'd if this were missing, so it's guaranteed present here.
  const proxySecret = (env.PROXY_SECRET ?? process.env.PROXY_SECRET) as string
  const tagOk = await verifyFetchTag(body.url, body.fetchTag, proxySecret)
  if (!tagOk) {
    recordGuardRejection(sub, config.guardRejectAlertThreshold)
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 403, guardRejectReason: 'untagged target' })
    return c.json({ error: 'untagged target' }, 403)
  }

  // Cumulative bytes/hour ceiling: checked before the fetch runs (so an already-blown quota is
  // rejected up front) and charged after it completes with the actual bytes consumed — this
  // package has no way to know a URL's response size before fetching it, so the ceiling is
  // enforced "check-before, charge-after" rather than aborting a single fetch mid-stream once its
  // own bytes alone would cross the line (fetchTextSafely's own maxBytes cap already bounds any
  // single call's damage regardless).
  const byteQuotaKey = `sub:${sub}`
  if (!byteCounter.peek(byteQuotaKey, config.bytesPerHour, HOUR_MS).allowed) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 429, guardRejectReason: 'bytes/hour quota exceeded' })
    return c.json({ error: 'bytes/hour quota exceeded' }, 429)
  }

  if (host) {
    const hostResult = hostCounter.consume(`host:${host}`, 1, config.hostRequestsPerHour, HOUR_MS)
    if (!hostResult.allowed) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 429, guardRejectReason: 'per-host throttle' })
      return c.json({ error: 'destination host rate limit exceeded' }, 429, { 'Retry-After': String(hostResult.retryAfterSeconds) })
    }
  }

  const concurrencyKey = `sub:${sub}`
  if (!fetchConcurrency.acquire(concurrencyKey, config.maxConcurrentFetches)) {
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 429, guardRejectReason: 'concurrency limit' })
    return c.json({ error: 'too many concurrent fetches' }, 429)
  }

  try {
    const result = await fetchTextSafely({ url: body.url })
    byteCounter.consume(byteQuotaKey, new TextEncoder().encode(result.text).length, config.bytesPerHour, HOUR_MS)
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 200, bytes: new TextEncoder().encode(result.text).length })
    return c.json(result)
  } catch (err) {
    if (err instanceof PrivateNetworkTargetError) {
      recordGuardRejection(sub, config.guardRejectAlertThreshold)
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 400, guardRejectReason: err.detail })
      return c.json({ error: err.detail }, 400)
    }
    if (err instanceof UnsupportedContentTypeError) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 415, guardRejectReason: err.detail })
      return c.json({ error: err.detail }, 415)
    }
    if (err instanceof Error && err.message.startsWith('Timed out fetching')) {
      logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 504 })
      return c.json({ error: err.message }, 504)
    }
    logWebRequest({ ts: new Date().toISOString(), sub, route: '/web/fetch', host, status: 502 })
    return c.json({ error: 'upstream fetch failed' }, 502)
  } finally {
    fetchConcurrency.release(concurrencyKey)
  }
}
