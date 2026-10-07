import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuthMiddleware, secretsMatch, signToken } from './auth'
import { forwardToProvider } from './forward'
import { handleWebSearch } from './web-search'
import { handleWebFetch } from './web-fetch'
import { handleWebGrant } from './web-grant'
import { createWebQuotaMiddleware, clientIpOptions } from './web-quota-middleware'
import { HOUR_MS, authFailCounter, clientIp } from './rate-limit'

type Bindings = {
  ALLOWED_ORIGIN: string
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  PROXY_SECRET: string
  /** Fallback only, for a self-hosted operator who wants one shared key for their own deployment
   * — the browser client normally sends its own key fresh on every /web/search call instead (see
   * web-search.ts's braveApiKey request field). Not required for that per-user path. */
  BRAVE_API_KEY?: string
  // /web/* quota tuning (all optional — see rate-limit.ts's DEFAULTS for fallbacks)
  WEB_REQUESTS_PER_HOUR?: string
  WEB_BYTES_PER_HOUR?: string
  WEB_MAX_CONCURRENT_FETCHES?: string
  WEB_HOST_REQUESTS_PER_HOUR?: string
  WEB_PER_IP_REQUESTS_PER_HOUR?: string
  WEB_BRAVE_DAILY_CEILING?: string
  WEB_GRANT_REQUESTS_PER_HOUR?: string
  WEB_GUARD_REJECT_ALERT_THRESHOLD?: string
  /** Set to 1 only behind a reverse proxy that overwrites x-forwarded-for / x-real-ip; otherwise the per-IP limit uses the TCP peer. */
  TRUST_PROXY_HEADERS?: string
  /** Failed /auth/token attempts allowed per client IP per hour (default 10). */
  AUTH_FAILS_PER_HOUR?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const origin = c.env?.ALLOWED_ORIGIN ?? process.env.ALLOWED_ORIGIN ?? '*'
  const corsMiddleware = cors({
    origin,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
  })
  return corsMiddleware(c, next)
})

app.get('/health', (c) => c.json({ status: 'ok' }))

app.post('/auth/token', async (c) => {
  const proxySecret = c.env?.PROXY_SECRET ?? process.env.PROXY_SECRET
  if (!proxySecret) return c.json({ error: 'server misconfigured' }, 500)
  // Failed-attempt throttle per client IP: the shared secret is the only credential, so bound guessing.
  const env = (c.env ?? {}) as Record<string, string | undefined>
  const failKey = `ip:${clientIp(c.req.raw.headers, clientIpOptions(c, env))}`
  const failLimitRaw = Number(env.AUTH_FAILS_PER_HOUR ?? process.env.AUTH_FAILS_PER_HOUR)
  const failLimit = Number.isFinite(failLimitRaw) && failLimitRaw > 0 ? failLimitRaw : 10
  const blocked = authFailCounter.peek(failKey, failLimit, HOUR_MS)
  if (!blocked.allowed) return c.json({ error: 'too many failed attempts' }, 429, { 'Retry-After': String(blocked.retryAfterSeconds) })
  const body = await c.req.json<{ secret?: unknown }>().catch(() => ({} as { secret?: unknown }))
  if (!(await secretsMatch(body?.secret, proxySecret))) {
    authFailCounter.consume(failKey, 1, Number.MAX_SAFE_INTEGER, HOUR_MS)
    return c.json({ error: 'unauthorized' }, 401)
  }
  const token = await signToken(proxySecret)
  return c.json({ token })
})

app.post('/llm/chat', createAuthMiddleware(), async (c) => {
  return forwardToProvider(c)
})

app.post('/web/search', createAuthMiddleware(), createWebQuotaMiddleware(), async (c) => {
  return handleWebSearch(c)
})

app.post('/web/fetch', createAuthMiddleware(), createWebQuotaMiddleware(), async (c) => {
  return handleWebFetch(c)
})

app.post('/web/grant', createAuthMiddleware(), createWebQuotaMiddleware(), async (c) => {
  return handleWebGrant(c)
})

export default app
