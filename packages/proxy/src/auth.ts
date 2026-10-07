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
