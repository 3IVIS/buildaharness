import type { Context } from 'hono'
import { fetchTextSafely, PrivateNetworkTargetError, UnsupportedContentTypeError } from './web-fetch-core'

interface WebFetchRequestBody {
  url?: string
}

export async function handleWebFetch(c: Context): Promise<Response> {
  const body = await c.req.json<WebFetchRequestBody>().catch(() => null)
  if (!body || typeof body.url !== 'string' || !body.url.trim()) {
    return c.json({ error: 'missing url field' }, 400)
  }

  try {
    const result = await fetchTextSafely({ url: body.url })
    return c.json(result)
  } catch (err) {
    if (err instanceof PrivateNetworkTargetError) {
      return c.json({ error: err.detail }, 400)
    }
    if (err instanceof UnsupportedContentTypeError) {
      return c.json({ error: err.detail }, 415)
    }
    if (err instanceof Error && err.message.startsWith('Timed out fetching')) {
      return c.json({ error: err.message }, 504)
    }
    return c.json({ error: 'upstream fetch failed' }, 502)
  }
}
