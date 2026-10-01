import { describe, it, expect } from 'vitest'
import { fetchTextRejectingServerErrors, UpstreamServerError } from './web-fetch'
import type { DnsResolver } from './web-fetch-core'

// POST /web/fetch used to answer 200 with the error page's text for an upstream 5xx, so the caller's own tool-failure
// accounting saw a successful fetch (a polling loop against a down endpoint never registered as failing).

const dns: DnsResolver = async () => ['93.184.216.34']
const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain' } })

describe('fetchTextRejectingServerErrors', () => {
  it('a 5xx becomes an UpstreamServerError carrying the status', async () => {
    const fetchImpl = (async () => text('Service Unavailable', 503)) as typeof fetch
    const err = await fetchTextRejectingServerErrors('https://example.com/health', { fetchImpl, dns }).catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamServerError)
    expect((err as UpstreamServerError).status).toBe(503)
    expect((err as UpstreamServerError).message).toBe('upstream responded HTTP 503')
  })

  it('the final response decides: a redirect to a 502 is an error', async () => {
    let calls = 0
    const fetchImpl = (async () => (++calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://example.com/health' } }) : text('Bad Gateway', 502))) as typeof fetch
    await expect(fetchTextRejectingServerErrors('https://example.com/old', { fetchImpl, dns })).rejects.toBeInstanceOf(UpstreamServerError)
  })

  it('a 4xx page stays content, and a 2xx is unchanged', async () => {
    const notFound = await fetchTextRejectingServerErrors('https://example.com/x', { fetchImpl: (async () => text('Not Found', 404)) as typeof fetch, dns })
    expect(notFound.text).toBe('Not Found')
    const ok = await fetchTextRejectingServerErrors('https://example.com/y', { fetchImpl: (async () => text('hello', 200)) as typeof fetch, dns })
    expect(ok.text).toBe('hello')
  })
})
