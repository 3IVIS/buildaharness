import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsBackend } from '@buildaharness/runtime'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => spawnMock(...args)
  return { spawn, default: { spawn } }
})

const { checkProxyHealth, checkClaudeCli, checkWorkspaceRoot, checkDataDirWritable } = await import('./doctor-checks.js')

function fakeProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  proc.kill = vi.fn()
  return proc
}

function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) { return files.get(path) },
    async writeTextFile(path, contents) { files.set(path, contents) },
    async removeFile(path) { files.delete(path) },
    async mkdir() {},
    async readDir() { return [] },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  spawnMock.mockReset()
})

describe('checkProxyHealth', () => {
  it('reports ok when the endpoint returns {status: "ok"}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })))

    const result = await checkProxyHealth('http://localhost:8787')

    expect(result).toEqual({ label: 'proxy reachable (http://localhost:8787/health)', ok: true })
  })

  it('reports not-ok on a non-200 response, with the status code as detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    const result = await checkProxyHealth('http://localhost:8787')

    expect(result.ok).toBe(false)
    expect(result.detail).toBe('HTTP 500')
  })

  it('reports not-ok on an unexpected response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 })))

    const result = await checkProxyHealth('http://localhost:8787')

    expect(result.ok).toBe(false)
    expect(result.detail).toBe('unexpected response body')
  })

  it('reports "timed out" rather than hanging when fetch never resolves', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })))

    const promise = checkProxyHealth('http://localhost:8787')
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise

    expect(result).toEqual({ label: 'proxy reachable (http://localhost:8787/health)', ok: false, detail: 'timed out' })
    vi.useRealTimers()
  })

  it('reports the error message when fetch rejects for a non-abort reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await checkProxyHealth('http://localhost:8787')

    expect(result.ok).toBe(false)
    expect(result.detail).toBe('ECONNREFUSED')
  })
})

describe('checkClaudeCli', () => {
  it('reports ok when the binary exits 0', async () => {
    spawnMock.mockImplementation(() => {
      const proc = fakeProcess()
      queueMicrotask(() => proc.emit('close', 0))
      return proc
    })

    const result = await checkClaudeCli('claude')

    expect(result).toEqual({ label: 'claude binary (claude)', ok: true })
  })

  it('reports "not found" when spawn errors (binary missing)', async () => {
    spawnMock.mockImplementation(() => {
      const proc = fakeProcess()
      queueMicrotask(() => proc.emit('error', new Error('ENOENT')))
      return proc
    })

    const result = await checkClaudeCli('claude')

    expect(result).toEqual({ label: 'claude binary (claude)', ok: false, detail: 'not found' })
  })

  it('reports a non-zero exit code as detail', async () => {
    spawnMock.mockImplementation(() => {
      const proc = fakeProcess()
      queueMicrotask(() => proc.emit('close', 1))
      return proc
    })

    const result = await checkClaudeCli('claude')

    expect(result).toEqual({ label: 'claude binary (claude)', ok: false, detail: 'exited with code 1' })
  })
})

describe('checkWorkspaceRoot', () => {
  it('reports ok for an existing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctor-check-'))
    try {
      const result = await checkWorkspaceRoot(dir)
      expect(result).toEqual({ label: `workspace root exists (${dir})`, ok: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports "not found" for a path that does not exist', async () => {
    const result = await checkWorkspaceRoot('/no/such/path/doctor-test')
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('not found')
  })
})

describe('checkDataDirWritable', () => {
  it('reports ok when the backend can write and remove a probe file', async () => {
    const backend = makeFakeBackend()
    const result = await checkDataDirWritable(backend, '/data/dir')
    expect(result).toEqual({ label: 'data dir writable (/data/dir)', ok: true })
  })

  it('reports the error message when the backend throws', async () => {
    const backend = makeFakeBackend()
    backend.writeTextFile = async () => { throw new Error('EACCES: permission denied') }

    const result = await checkDataDirWritable(backend, '/data/dir')

    expect(result).toEqual({ label: 'data dir writable (/data/dir)', ok: false, detail: 'EACCES: permission denied' })
  })
})
