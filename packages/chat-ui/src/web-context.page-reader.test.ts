import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pageReader } from './web-context'
import { isUserAuthoredUrl } from './user-urls'

describe('reading a page as text for Write', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  it('remembers the address as the writer\'s own, then reads it through fetch_url with the host\'s fetch and address guard', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('<html><body><p>Hello page</p></body></html>', { headers: { 'content-type': 'text/html' } }) }) as unknown as typeof fetch
    const dns = vi.fn(async () => ['93.184.216.34'])
    const read = pageReader({ search: async () => [], fetchImpl, dns })
    const text = await read('https://example.com/post')
    expect(isUserAuthoredUrl('https://example.com/post')).toBe(true)
    expect(dns).toHaveBeenCalledWith('example.com')
    expect(urls).toEqual(['https://example.com/post'])
    expect(text).toContain('Hello page')
  })
  it('refuses an address that resolves to a private one', async () => {
    const read = pageReader({ search: async () => [], fetchImpl: (async () => new Response('x')) as unknown as typeof fetch, dns: async () => ['10.0.0.5'] })
    await expect(read('https://internal.example/x')).rejects.toThrow()
  })
})
