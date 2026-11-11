import { createMiddleware } from 'hono/factory'
import { SignJWT, jwtVerify } from 'jose'
import { clientIp } from './rate-limit'
import { clientIpOptions } from './web-quota-middleware'

function getSecret(secretStr: string): Uint8Array {
  return new TextEncoder().encode(secretStr)
}

/**
 * The browser origins (exact match, comma-separated in ANONYMOUS_WEB_ORIGINS) whose pages may call /web/* without a
 * token. Off when the variable is unset, which is the default for a self-hosted proxy.
 */
export function anonymousWebOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env.ANONYMOUS_WEB_ORIGINS ?? process.env.ANONYMOUS_WEB_ORIGINS ?? ''
  return raw.split(',').map((o) => o.trim()).filter(Boolean)
}

/**
 * Auth for /web/*: a bearer token, when one is sent, is always checked like on every other route, so a visitor who gives
 * their own proxy token keeps working and a wrong token is refused. With no token (or an empty "Bearer "), the request
 * is let in only when its Origin header is one of ANONYMOUS_WEB_ORIGINS (the hosted myaielia.com pages, which carry no
 * secret). Each anonymous visitor is then counted under their own IP (`anon:<ip>`), so the per-token and per-IP limits
 * in the quota middleware protect the proxy and one visitor cannot use up another's allowance.
 *
 * The Origin header is set by browsers and can be set by any other client too, so this is not a lock: the limits are
 * what bounds anonymous use, as they are for a token that is public in a page's script. /llm/chat is never anonymous.
 */
export function createWebAuthMiddleware() {
  const withToken = createAuthMiddleware()
  return createMiddleware(async (c, next) => {
    const env = (c.env ?? {}) as Record<string, string | undefined>
    const authHeader = c.req.header('Authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (bearer) return withToken(c, next)
    const proxySecret = env.PROXY_SECRET ?? process.env.PROXY_SECRET
    if (!proxySecret) return c.json({ error: 'server misconfigured' }, 500)
    const origin = c.req.header('Origin')
    if (!origin || !anonymousWebOrigins(env).includes(origin)) return c.json({ error: 'unauthorized' }, 401)
    const ip = clientIp(c.req.raw.headers, clientIpOptions(c, env))
    c.set('jwtPayload', { payload: { sub: `anon:${ip}` } })
    await next()
  })
}

export function createAuthMiddleware() {
  return createMiddleware(async (c, next) => {
    const proxySecret = c.env?.PROXY_SECRET ?? process.env.PROXY_SECRET
    if (!proxySecret) {
      return c.json({ error: 'server misconfigured' }, 500)
    }
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const token = authHeader.slice(7)
    try {
      const payload = await jwtVerify(token, getSecret(proxySecret))
      c.set('jwtPayload', payload)
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })
}

export async function signToken(proxySecret: string): Promise<string> {
  return new SignJWT({ sub: 'runtime', jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(getSecret(proxySecret))
}

/** Constant-time string equality: both sides are hashed to a fixed length, then compared without early exit. */
export async function secretsMatch(provided: unknown, expected: string): Promise<boolean> {
  if (typeof provided !== 'string') return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
