import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkProxyHealth } from './proxy-health.js'

const okFetch = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))

afterEach(() => {
  vi.useRealTimers()
})

describe('checkProxyHealth', () => {
  it('reports ok when the endpoint returns {status: "ok"}', async () => {
    expect(await checkProxyHealth('http://localhost:8787', okFetch())).toEqual({ label: 'proxy reachable (http://localhost:8787/health)', ok: true })
  })

  it('reports not-ok on an HTTP error, with the status as detail', async () => {
    const result = await checkProxyHealth('http://localhost:8787', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    expect(result).toMatchObject({ ok: false, detail: 'HTTP 500' })
  })

  it('reports not-ok on an unexpected body', async () => {
    const result = await checkProxyHealth('http://localhost:8787', vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 })))
    expect(result).toMatchObject({ ok: false, detail: 'unexpected response body' })
  })

  it('reports the error message when the request rejects', async () => {
    const result = await checkProxyHealth('http://localhost:8787', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(result).toMatchObject({ ok: false, detail: 'ECONNREFUSED' })
  })

  it('reports "timed out" rather than hanging when the request never resolves', async () => {
    vi.useFakeTimers()
    const hang = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const promise = checkProxyHealth('http://localhost:8787', hang as unknown as typeof fetch)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await promise).toMatchObject({ ok: false, detail: 'timed out' })
  })

  it('masks credentials in the label but still requests the real URL', async () => {
    const fetchImpl = okFetch()
    const result = await checkProxyHealth('http://u:secretpw@localhost:8787', fetchImpl)
    expect(result.label).not.toContain('secretpw')
    expect(fetchImpl).toHaveBeenCalledWith('http://u:secretpw@localhost:8787/health', expect.anything())
  })

  it('uses the global fetch when none is passed', async () => {
    const spy = okFetch()
    vi.stubGlobal('fetch', spy)
    await checkProxyHealth('http://localhost:8787')
    vi.unstubAllGlobals()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
