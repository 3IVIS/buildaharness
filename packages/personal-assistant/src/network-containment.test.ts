import { describe, it, expect, afterEach } from 'vitest'
import { connect, createServer, type Server } from 'node:net'
import { getNetworkContainmentProxy, resetNetworkContainmentProxiesForTests } from './network-containment.js'

/**
 * F8 (adoption plan): the "safer than an unsandboxed agent" claim leans on this containment
 * proxy, so the boundary gets tests named next to it — not only the end-to-end coverage in
 * shell-executor.test.ts. The load-bearing invariant is that an EMPTY allowlist denies every
 * host (the default when the user configures none): a containment layer that fails open would
 * be worse than none, because the docs say it's there.
 */

/** Sends one proxy request line and resolves with the proxy's raw response (first chunk). */
function proxyRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('utf-8')
      socket.end()
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('proxy did not respond'))
    })
  })
}

describe('network containment proxy', () => {
  afterEach(async () => {
    await resetNetworkContainmentProxiesForTests()
  })

  it('an empty allowlist denies every host with a 403', async () => {
    const proxy = await getNetworkContainmentProxy([])
    const response = await proxyRequest(proxy.port, 'CONNECT anything.example:443 HTTP/1.1')
    expect(response).toContain('403 Forbidden')
  })

  it('denies a host that is not on a non-empty allowlist', async () => {
    const proxy = await getNetworkContainmentProxy(['allowed.example'])
    const response = await proxyRequest(proxy.port, 'CONNECT evil.example:443 HTTP/1.1')
    expect(response).toContain('403 Forbidden')
  })

  it('allows an exact allowlist match and its subdomains, and tunnels to the real upstream', async () => {
    const upstream = createServer((sock) => sock.end('hello-upstream'))
    const upstreamPort = await new Promise<number>((res) => {
      upstream.listen(0, '127.0.0.1', () => {
        const addr = upstream.address()
        res(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    try {
      // '127.0.0.1' on the allowlist — the CONNECT target host must match it exactly.
      const proxy = await getNetworkContainmentProxy(['127.0.0.1'])
      const response = await proxyRequest(proxy.port, `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1`)
      expect(response).toContain('200 Connection Established')
    } finally {
      await new Promise<void>((res) => upstream.close(() => res()))
    }
  })

  it('reuses one proxy instance per allowlist (order- and case-independent)', async () => {
    const a = await getNetworkContainmentProxy(['a.example', 'B.example'])
    const b = await getNetworkContainmentProxy(['b.example', 'A.example'])
    expect(a.port).toBe(b.port)
    const c = await getNetworkContainmentProxy(['different.example'])
    expect(c.port).not.toBe(a.port)
  })
})
