import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuthMiddleware, signToken } from './auth'
import { forwardToProvider } from './forward'

type Bindings = {
  ALLOWED_ORIGIN: string
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  PROXY_SECRET: string
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

export default app
