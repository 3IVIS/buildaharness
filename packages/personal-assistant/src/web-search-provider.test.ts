import { describe, it, expect, vi } from 'vitest'
import { duckDuckGoSearch } from './web-search-provider.js'

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('duckDuckGoSearch', () => {
  it('parses a bounded, structured result list from DDG HTML markup', async () => {
    const html = `
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Result A</a></h2>
        <a class="result__snippet">Snippet for A</a>
      </div>
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Result B</a></h2>
        <a class="result__snippet">Snippet for B</a>
      </div>
    `
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(html))

    const results = await duckDuckGoSearch('test query', { fetchImpl })

    expect(results).toEqual([
      { title: 'Result A', url: 'https://example.com/a', snippet: 'Snippet for A' },
      { title: 'Result B', url: 'https://example.com/b', snippet: 'Snippet for B' },
    ])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://html.duckduckgo.com/html/',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('handles zero results without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('<div class="no-results">No results.</div>'))

    const results = await duckDuckGoSearch('a query with no matches', { fetchImpl })

    expect(results).toEqual([])
  })

  it('caps the number of returned results at maxResults', async () => {
    const block = (n: number) =>
      `<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F${n}">Result ${n}</a></h2><a class="result__snippet">Snippet ${n}</a>`
    const fetchImpl = vi.fn().mockResolvedValue(textResponse([1, 2, 3, 4, 5].map(block).join('\n')))

    const results = await duckDuckGoSearch('query', { fetchImpl, maxResults: 2 })

    expect(results).toHaveLength(2)
  })

  it('throws a clear error on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('', 503))

    await expect(duckDuckGoSearch('query', { fetchImpl })).rejects.toThrow(/503/)
  })
})
