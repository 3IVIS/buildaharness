import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
// @ts-expect-error — plain ESM script, no .d.ts; it's import-safe (see its entry-point guard).
import { parseDdgResults, formatWebSearchResults, wrapUntrusted, requestToolGate } from './file-tools-mcp-server.mjs'

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

/**
 * Phase D0 (harness_consolidation_and_control_plane_plan.html): requestToolGate is the MCP
 * server's half of the propose→gate round trip claude-cli-llm-client.ts's startToolGateServer
 * implements on the parent side (see that file's own tests for the round trip driven from the
 * parent). Exercised here against a plain node:net server standing in for the parent, so this
 * file's pure-helper testing style (no live MCP client needed) extends to the gate too.
 */
describe('file-tools-mcp-server requestToolGate (Phase D0)', () => {
  let server: Server | undefined
  // requestToolGate now keeps its connection open across calls (see file-tools-mcp-server.mjs's
  // persistent gate socket) instead of destroying it after every round trip, so a client socket
  // from a test can still be alive when that test ends — a plain server.close() waits for
  // existing connections to end on their own and would hang forever. This Node build's
  // net.Server has no closeAllConnections()/closeIdleConnections(), so each test that accepts a
  // connection pushes it here and afterEach destroys them all first, the same effect by hand.
  let acceptedSockets: import('node:net').Socket[] = []
  const originalPort = process.env.TOOL_GATE_PORT

  afterEach(async () => {
    for (const socket of acceptedSockets) socket.destroy()
    acceptedSockets = []
    if (server) {
      await new Promise((resolve) => server!.close(resolve))
      server = undefined
    }
    if (originalPort === undefined) delete process.env.TOOL_GATE_PORT
    else process.env.TOOL_GATE_PORT = originalPort
  })

  it('allows by default when TOOL_GATE_PORT is unset', async () => {
    delete process.env.TOOL_GATE_PORT
    await expect(requestToolGate('read_file', { path: 'notes.txt' })).resolves.toEqual({ decision: 'allow' })
  })

  it('round-trips a request to the gate server and returns its decision verbatim', async () => {
    const received: { tool: string; input: Record<string, unknown> }[] = []
    server = createServer((socket) => {
      acceptedSockets.push(socket)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8')
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        received.push(JSON.parse(buffer.slice(0, nl)))
        socket.write(`${JSON.stringify({ decision: 'deny', reason: 'blocked by test gate' })}\n`)
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    process.env.TOOL_GATE_PORT = String((server.address() as { port: number }).port)

    const decision = await requestToolGate('fetch_url', { url: 'https://example.com' })

    expect(decision).toEqual({ decision: 'deny', reason: 'blocked by test gate' })
    expect(received).toEqual([{ tool: 'fetch_url', input: { url: 'https://example.com' } }])
  })

  it('fails open (allow) when the gate connection errors, rather than wedging the call', async () => {
    // Nothing listening on this port — connection refused.
    process.env.TOOL_GATE_PORT = '1'
    await expect(requestToolGate('read_file', { path: 'x' })).resolves.toEqual({ decision: 'allow' })
  })

  it('reuses one TCP connection across consecutive gated calls instead of reconnecting per call', async () => {
    let connectionCount = 0
    const received: { tool: string; input: Record<string, unknown> }[] = []
    server = createServer((socket) => {
      connectionCount++
      acceptedSockets.push(socket)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8')
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          const req = JSON.parse(line)
          received.push(req)
          socket.write(`${JSON.stringify({ decision: 'allow', reason: `ok:${req.tool}` })}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    process.env.TOOL_GATE_PORT = String((server.address() as { port: number }).port)

    const first = await requestToolGate('read_file', { path: 'a.txt' })
    const second = await requestToolGate('list_directory', { path: '.' })

    expect(first).toEqual({ decision: 'allow', reason: 'ok:read_file' })
    expect(second).toEqual({ decision: 'allow', reason: 'ok:list_directory' })
    expect(received).toEqual([
      { tool: 'read_file', input: { path: 'a.txt' } },
      { tool: 'list_directory', input: { path: '.' } },
    ])
    expect(connectionCount).toBe(1)
  })

  it(
    'fails open (via the request timeout) instead of hanging when the peer dies without notice',
    async () => {
      let connectionCount = 0
      let acceptedSocket: import('node:net').Socket | undefined
      server = createServer((socket) => {
        connectionCount++
        acceptedSocket = socket
        acceptedSockets.push(socket)
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8')
          const nl = buffer.indexOf('\n')
          if (nl === -1) return
          socket.write(`${JSON.stringify({ decision: 'allow' })}\n`)
        })
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      process.env.TOOL_GATE_PORT = String((server.address() as { port: number }).port)

      await expect(requestToolGate('read_file', { path: 'a.txt' })).resolves.toEqual({ decision: 'allow' })
      expect(connectionCount).toBe(1)

      // Destroying the accepted socket server-side doesn't reliably surface as an 'error'/'close'
      // event on the client's cached socket in every environment (confirmed by hand against this
      // one — a killed peer can go fully silent instead) — exactly the case
      // GATE_REQUEST_TIMEOUT_MS exists for. The next call must still resolve (fail open) rather
      // than hang forever waiting for a notification that may never come.
      acceptedSocket?.destroy()

      await expect(requestToolGate('read_file', { path: 'b.txt' })).resolves.toEqual({ decision: 'allow' })
    },
    // Comfortably above file-tools-mcp-server.mjs's GATE_REQUEST_TIMEOUT_MS (3000ms) so this
    // exercises the real timeout path rather than vitest's own default test timeout.
    6000,
  )

  it('fails open when the shared connection breaks and the next call has nothing to reach', async () => {
    server = createServer((socket) => {
      acceptedSockets.push(socket)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8')
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        socket.write(`${JSON.stringify({ decision: 'allow' })}\n`)
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    process.env.TOOL_GATE_PORT = String((server.address() as { port: number }).port)

    await expect(requestToolGate('read_file', { path: 'a.txt' })).resolves.toEqual({ decision: 'allow' })

    // Point the gate at a dead port for the next call — a port mismatch makes getGateSocket
    // drop the cached (still technically live) connection and dial fresh, landing on nothing
    // listening, same as the connection having broken with no server left to reconnect to. The
    // original connection's server-side socket is still tracked in acceptedSockets, so afterEach
    // cleans it up along with the server.
    process.env.TOOL_GATE_PORT = '1'

    await expect(requestToolGate('read_file', { path: 'b.txt' })).resolves.toEqual({ decision: 'allow' })
  })
})
