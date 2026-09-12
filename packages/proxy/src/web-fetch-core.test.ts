import { describe, it, expect } from 'vitest'
import { fetchTextSafely, PrivateNetworkTargetError, type DnsResolver } from './web-fetch-core'

// The full guard/redirect/byte-cap/content-type behavior is already exercised end-to-end through
// the real route in web-tools.integration.test.ts (mocked upstream + DNS, via app.request). This
// file covers one invariant that route-level testing can't directly assert: fetchTextSafely has
// no way to skip assertPublicHttpUrl, regardless of what a caller passes in FetchTextSafelyOptions.
// packages/personal-assistant/src/web-fetch-core.test.ts asserts the same invariant for the other
// hand-kept-in-sync copy of this module.

function fakeDns(map: Record<string, string[]>): DnsResolver {
  return async (hostname: string) => map[hostname] ?? []
}

describe('fetchTextSafely — guard cannot be bypassed', () => {
  it('rejects a private target even when an unrecognized options field (e.g. a future skipLocalGuard sentinel) is present', async () => {
    const internalDns = fakeDns({ 'internal.example': ['10.0.0.1'] })
    const fetchImpl = (async () => new Response('should never be reached')) as typeof fetch
    const optionsWithSentinel = { url: 'http://internal.example/', dns: internalDns, fetchImpl, skipLocalGuard: true } as Parameters<
      typeof fetchTextSafely
    >[0]
    await expect(fetchTextSafely(optionsWithSentinel)).rejects.toThrow(PrivateNetworkTargetError)
  })

  it('re-checks the guard on every redirect hop — a public first hop cannot smuggle a private target', async () => {
    const dns = fakeDns({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.0.0.1'] })
    const fetchImpl = (async () =>
      new Response('', { status: 302, headers: { location: 'http://internal.example/secret' } })) as typeof fetch
    await expect(fetchTextSafely({ url: 'http://public.example/', dns, fetchImpl })).rejects.toThrow(PrivateNetworkTargetError)
  })
})
