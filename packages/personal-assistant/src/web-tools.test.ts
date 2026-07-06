import { describe, it, expect } from 'vitest'
import { executeWebTool, type WebToolsContext } from './web-tools.js'

function makeCtx(overrides: Partial<WebToolsContext> = {}): WebToolsContext {
  return {
    async search() {
      return []
    },
    ...overrides,
  }
}

describe('executeWebTool', () => {
  it('web_search formats results as title/url/snippet blocks', async () => {
    const ctx = makeCtx({
      async search(query) {
        expect(query).toBe('capital of france')
        return [{ title: 'Paris', url: 'https://example.com/paris', snippet: 'Paris is the capital of France.' }]
      },
    })

    const result = await executeWebTool(ctx, 'web_search', { query: 'capital of france' })
    expect(result.text).toContain('Paris')
    expect(result.text).toContain('https://example.com/paris')
  })

  it('web_search reports no results plainly', async () => {
    const result = await executeWebTool(makeCtx(), 'web_search', { query: 'nothing' })
    expect(result.text).toBe('No results found.')
  })

  it('fetch_url returns the response body text using the injected fetch implementation', async () => {
    const ctx = makeCtx({
      fetchImpl: (async () => new Response('page body text')) as typeof fetch,
    })

    const result = await executeWebTool(ctx, 'fetch_url', { url: 'https://example.com' })
    expect(result.text).toBe('page body text')
  })

  it('throws for an unknown tool name', async () => {
    await expect(executeWebTool(makeCtx(), 'not_a_tool', {})).rejects.toThrow('Unknown web tool')
  })
})
