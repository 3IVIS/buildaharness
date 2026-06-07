import type { Context } from 'hono'
import { detectProvider, getProviderUrl, getApiKey } from './providers'

export async function forwardToProvider(c: Context): Promise<Response> {
  const body = await c.req.json<Record<string, unknown>>()
  const model = body.model as string | undefined
  if (!model) return c.json({ error: 'missing model field' }, 400) as Response

  const provider = detectProvider(model)
  if (!provider) return c.json({ error: 'unsupported_model' }, 400) as Response

  const env = (c.env ?? {}) as Record<string, string | undefined>
  const apiKey = getApiKey(provider, env)
  if (!apiKey) return c.json({ error: 'api key not configured' }, 500) as Response

  const forwardBody = { ...body, stream: true }
  // Strip client-supplied Authorization before forwarding
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }
  if (provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
  }

  const upstream = await fetch(getProviderUrl(provider), {
    method: 'POST',
    headers,
    body: JSON.stringify(forwardBody),
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
}
