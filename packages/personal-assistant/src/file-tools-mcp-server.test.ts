import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM script, no .d.ts; it's import-safe (see its entry-point guard).
import { parseDdgResults, formatWebSearchResults, wrapUntrusted } from './file-tools-mcp-server.mjs'

/**
 * F3 (adoption plan): the claude-cli backend's MCP server gained web_search. The tool
 * executor itself isn't unit-testable here (importing the server to *run* a tool would
 * need a live stdio client), but its pure pieces — the DuckDuckGo markup parser ported
 * from web-search-provider.ts, the shared result formatting, and the untrusted-content
 * wrapper applied in-server — are. The MCP server's own `--test` self-check covers the
 * end-to-end runWebSearch path with an injected fetch.
 */
describe('file-tools-mcp-server web_search helpers', () => {
  it('parseDdgResults unwraps DDG redirect hrefs and strips result markup', () => {
    const html =
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First &amp; Best</a>' +
      '<a class="result__snippet">A <b>short</b> snippet.</a>' +
      '<a class="result__a" href="https://plain.example/b">Second</a>' +
      '<a class="result__snippet">Another one.</a>'
    const results = parseDdgResults(html)
    expect(results).toEqual([
      { title: 'First & Best', url: 'https://example.com/a', snippet: 'A short snippet.' },
      { title: 'Second', url: 'https://plain.example/b', snippet: 'Another one.' },
    ])
  })

  it('parseDdgResults caps the result count', () => {
    const html = Array.from({ length: 10 }, (_, i) => `<a class="result__a" href="https://e.example/${i}">R${i}</a>`).join('')
    expect(parseDdgResults(html, 3)).toHaveLength(3)
  })

  it('formatWebSearchResults matches web-tools.ts executeWebTool: title\\nurl\\nsnippet blocks, shared empty literal', () => {
    expect(formatWebSearchResults([])).toBe('No results found.')
    expect(formatWebSearchResults([{ title: 'T', url: 'https://u.example', snippet: 'S' }])).toBe('T\nhttps://u.example\nS')
  })

  it('wrapUntrusted wraps search output in the same boundary the proxy backend uses', () => {
    const wrapped = wrapUntrusted(formatWebSearchResults([{ title: 'T', url: 'https://u.example', snippet: 'S' }]))
    expect(wrapped).toBe('<untrusted_external_content>\nT\nhttps://u.example\nS\n</untrusted_external_content>')
  })
})
