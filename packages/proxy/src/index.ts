import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuthMiddleware, signToken } from './auth'
import { forwardToProvider } from './forward'
import { handleWebSearch } from './web-search'
import { handleWebFetch } from './web-fetch'
import { handleWebGrant } from './web-grant'
import { createWebQuotaMiddleware } from './web-quota-middleware'

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
  const body = await c.req.json<{ secret?: string }>().catch(() => ({} as { secret?: string }))
  if (body.secret !== proxySecret) return c.json({ error: 'unauthorized' }, 401)
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
