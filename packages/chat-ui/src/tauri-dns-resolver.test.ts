import { describe, it, expect, vi, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

const { tauriDnsResolver } = await import('./tauri-dns-resolver.js')

afterEach(() => {
  vi.clearAllMocks()
})

describe('tauriDnsResolver', () => {
  it('invokes dns_lookup with the hostname and returns the resolved addresses', async () => {
    invokeMock.mockResolvedValue(['93.184.216.34'])

    const result = await tauriDnsResolver('example.com')

    expect(result).toEqual(['93.184.216.34'])
    expect(invokeMock).toHaveBeenCalledWith('dns_lookup', { hostname: 'example.com' })
  })

  it('propagates a rejection (e.g. NXDOMAIN) rather than swallowing it', async () => {
    invokeMock.mockRejectedValue(new Error("Couldn't resolve \"nonexistent.invalid\": failed to lookup address information"))

    await expect(tauriDnsResolver('nonexistent.invalid')).rejects.toThrow('nonexistent.invalid')
  })
})
