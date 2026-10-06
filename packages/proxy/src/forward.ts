import type { Context } from 'hono'
import { detectProvider, getProviderUrl, getApiKey } from './providers'

export async function forwardToProvider(c: Context): Promise<Response> {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid JSON body' }, 400) as Response
  const model = typeof body.model === 'string' ? body.model : undefined
  if (!model) return c.json({ error: 'missing model field' }, 400) as Response

  const provider = detectProvider(model)
  if (!provider) return c.json({ error: 'unsupported_model' }, 400) as Response

  const env = (c.env ?? {}) as Record<string, string | undefined>
  const apiKey = getApiKey(provider, env)
  if (!apiKey) return c.json({ error: 'api key not configured' }, 500) as Response

  const forwardBody = { ...body }
  if (!('stream' in body)) forwardBody.stream = true
  // Strip client-supplied Authorization before forwarding
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (provider === 'anthropic') {
    // Anthropic's Messages API authenticates API keys via x-api-key; a Bearer header is rejected.
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  let upstream: Response
  try {
    upstream = await fetch(getProviderUrl(provider), {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardBody),
    })
  } catch {
    return c.json({ error: 'upstream request failed' }, 502) as Response
  }

  if (forwardBody.stream === false) {
    const text = await upstream.text()
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
}
