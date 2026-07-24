import { createServer, connect as netConnect, type Socket, type Server } from 'node:net'

/**
 * Node-level network containment for an approved run_shell_command execution — Decision 6 of
 * plans/lexical_functions_hardening_plan.html (Phase 4 step 2). This is the network-reachability
 * half of that decision; the env-stripping half already existed in shell-executor.ts's
 * allowlistedEnv(). Deliberately not a real OS sandbox (see the plan's Decision 6 for why that
 * tradeoff was chosen): a minimal loopback-only forward proxy that relays a CONNECT tunnel
 * (HTTPS) or a plain-HTTP proxy request only when its target host matches an entry in the
 * caller-supplied allowlist (exact match or subdomain), and otherwise closes the connection with
 * a 403. The spawned subprocess's HTTP(S)_PROXY env vars are forced to point here, so a tool that
 * honors those (curl, wget, most language HTTP clients) can only reach an allowlisted host. This
 * does NOT stop a tool that opens raw sockets and ignores proxy env vars entirely — that
 * limitation is Decision 6's explicitly accepted tradeoff for a dependency-free, Node-only
 * implementation identical across CLI and desktop.
 */

export interface NetworkContainmentProxy {
  port: number
  close: () => Promise<void>
}

const MAX_HEADER_BYTES = 16_384

function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const normalized = host.toLowerCase()
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase()
    return normalized === allowed || normalized.endsWith(`.${allowed}`)
  })
}

function parseConnectTarget(requestLine: string): { host: string; port: number } | null {
  const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP/i.exec(requestLine)
  return match ? { host: match[1], port: Number(match[2]) } : null
}

function parsePlainHttpTarget(requestLine: string, headerText: string): { host: string; port: number } | null {
  const absoluteUri = /^[A-Z]+\s+https?:\/\/([^/:\s]+)(?::(\d+))?/i.exec(requestLine)
  if (absoluteUri) return { host: absoluteUri[1], port: Number(absoluteUri[2] ?? 80) }

  const hostHeader = /^host:\s*([^\s:]+)(?::(\d+))?/im.exec(headerText)
  return hostHeader ? { host: hostHeader[1], port: Number(hostHeader[2] ?? 80) } : null
}

function handleConnection(clientSocket: Socket, allowlist: readonly string[]): void {
  let buffered = Buffer.alloc(0)

  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    const headerEnd = buffered.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      if (buffered.length > MAX_HEADER_BYTES) clientSocket.destroy()
      return
    }
    clientSocket.removeListener('data', onData)

    const headerText = buffered.slice(0, headerEnd).toString('utf-8')
    const requestLine = headerText.split('\r\n')[0] ?? ''
    const isConnect = /^CONNECT\s/i.test(requestLine)
    const target = isConnect ? parseConnectTarget(requestLine) : parsePlainHttpTarget(requestLine, headerText)

    if (!target || !hostAllowed(target.host, allowlist)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }

    const upstream = netConnect(target.port, target.host, () => {
      if (isConnect) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const tunnelBytes = buffered.slice(headerEnd + 4)
        if (tunnelBytes.length > 0) upstream.write(tunnelBytes)
      } else {
        upstream.write(buffered)
      }
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on('error', () => clientSocket.destroy())
  }

  clientSocket.on('data', onData)
  clientSocket.on('error', () => clientSocket.destroy())
}

function startProxyServer(allowlist: readonly string[]): Promise<NetworkContainmentProxy> {
  return new Promise((resolveStart, rejectStart) => {
    const server: Server = createServer((socket) => handleConnection(socket, allowlist))
    server.on('error', rejectStart)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectStart(new Error('Failed to bind network containment proxy to a loopback port'))
        return
      }
      resolveStart({
        port: address.port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}

/**
 * Lazily starts (or reuses) a loopback-only proxy scoped to `allowlist`, keyed by its
 * (order-independent, case-insensitive) contents so repeated calls with the same allowlist reuse
 * one long-lived proxy instead of spawning a new server per shell command. Left running for the
 * process's lifetime — acceptable for a CLI/desktop session, not meant to be torn down mid-run.
 */
const proxyCache = new Map<string, Promise<NetworkContainmentProxy>>()

export function getNetworkContainmentProxy(allowlist: readonly string[]): Promise<NetworkContainmentProxy> {
  const key = JSON.stringify([...allowlist].map((host) => host.toLowerCase()).sort())
  let proxy = proxyCache.get(key)
  if (!proxy) {
    proxy = startProxyServer(allowlist)
    proxyCache.set(key, proxy)
  }
  return proxy
}

/** Test-only: drops all cached proxies so a test's allowlist doesn't leak into another test's expectations. */
export async function resetNetworkContainmentProxiesForTests(): Promise<void> {
  const proxies = [...proxyCache.values()]
  proxyCache.clear()
  for (const proxyPromise of proxies) {
    const proxy = await proxyPromise
    await proxy.close()
  }
}
