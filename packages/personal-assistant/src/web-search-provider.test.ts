import { describe, it, expect, vi } from 'vitest'
import { braveSearch } from './web-search-provider.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('braveSearch', () => {
  it('parses a bounded, structured result list from the Brave API response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        web: {
          results: [
            { title: 'Result A', url: 'https://example.com/a', description: 'Snippet for A' },
            { title: 'Result B', url: 'https://example.com/b', description: 'Snippet for B' },
          ],
        },
      }),
    )

    const results = await braveSearch('test query', 'test-api-key', { fetchImpl })

    expect(results).toEqual([
      { title: 'Result A', url: 'https://example.com/a', snippet: 'Snippet for A' },
      { title: 'Result B', url: 'https://example.com/b', snippet: 'Snippet for B' },
    ])
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0]
    expect(new URL(calledUrl).origin + new URL(calledUrl).pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(new URL(calledUrl).searchParams.get('q')).toBe('test query')
    expect(calledInit.headers['X-Subscription-Token']).toBe('test-api-key')
  })

  it('handles a response with no web results without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))

    const results = await braveSearch('a query with no matches', 'test-api-key', { fetchImpl })

    expect(results).toEqual([])
  })

  it('caps the number of returned results at maxResults', async () => {
    const results = [1, 2, 3, 4, 5].map((n) => ({ title: `Result ${n}`, url: `https://example.com/${n}`, description: `Snippet ${n}` }))
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ web: { results } }))

    const capped = await braveSearch('query', 'test-api-key', { fetchImpl, maxResults: 2 })

    expect(capped).toHaveLength(2)
  })

  it('throws a clear error on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401))

    await expect(braveSearch('query', 'bad-key', { fetchImpl })).rejects.toThrow(/401/)
  })
})
