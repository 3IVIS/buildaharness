import { createMiddleware } from 'hono/factory'
import { SignJWT, jwtVerify } from 'jose'

function getSecret(secretStr: string): Uint8Array {
  return new TextEncoder().encode(secretStr)
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
