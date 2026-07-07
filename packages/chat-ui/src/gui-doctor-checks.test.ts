import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

const { checkProxyReachable, checkClaudeAvailable, checkWorkspaceConfigured, checkDataDirWritable } = await import('./gui-doctor-checks.js')

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
  invokeMock.mockReset()
})

describe('checkProxyReachable', () => {
  it('reports ok when the endpoint returns {status: "ok"}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })))
    const result = await checkProxyReachable('http://localhost:8787')
    expect(result).toEqual({ label: 'proxy reachable (http://localhost:8787/health)', ok: true })
  })

  it('reports not-ok on a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    const result = await checkProxyReachable('http://localhost:8787')
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('HTTP 500')
  })

  it('reports the error message when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await checkProxyReachable('http://localhost:8787')
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('ECONNREFUSED')
  })
})

describe('checkClaudeAvailable', () => {
  it('reports ok when the Tauri command resolves true', async () => {
    invokeMock.mockResolvedValue(true)
    const result = await checkClaudeAvailable()
    expect(result).toEqual({ label: 'claude binary (desktop)', ok: true })
  })

  it('reports not-ok when the Tauri command resolves false', async () => {
    invokeMock.mockResolvedValue(false)
    const result = await checkClaudeAvailable()
    expect(result).toEqual({ label: 'claude binary (desktop)', ok: false, detail: 'not found' })
  })

  it('reports the error message when the Tauri command rejects', async () => {
    invokeMock.mockRejectedValue(new Error('command not found'))
    const result = await checkClaudeAvailable()
    expect(result).toEqual({ label: 'claude binary (desktop)', ok: false, detail: 'command not found' })
  })
})

describe('checkWorkspaceConfigured', () => {
  it('reports ok with the path when a workspace root is resolved', () => {
    expect(checkWorkspaceConfigured('/Users/me/project')).toEqual({ label: 'workspace root (/Users/me/project)', ok: true })
  })

  it('reports not-ok when no workspace root is resolved', () => {
    expect(checkWorkspaceConfigured(undefined)).toEqual({ label: 'workspace root', ok: false, detail: 'not resolved' })
  })
})

describe('checkDataDirWritable', () => {
  it('reports ok when the backend can write and remove a probe file', async () => {
    const result = await checkDataDirWritable(makeFakeBackend(), '/data/dir')
    expect(result).toEqual({ label: 'data dir writable (/data/dir)', ok: true })
  })

  it('reports the error message when the backend throws', async () => {
    const backend = makeFakeBackend()
    backend.writeTextFile = async () => { throw new Error('permission denied') }
    const result = await checkDataDirWritable(backend, '/data/dir')
    expect(result).toEqual({ label: 'data dir writable (/data/dir)', ok: false, detail: 'permission denied' })
  })
})
