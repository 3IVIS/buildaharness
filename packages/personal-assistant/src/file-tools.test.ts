import { describe, it, expect, vi } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import {
  resolveInWorkspace,
  PathOutsideWorkspaceError,
  executeFileTool,
  stagePendingAction,
  loadPendingAction,
  applyPendingAction,
  discardPendingAction,
  recordShellCacheEntry,
  findCachedShellResult,
  type FileToolsContext,
} from './file-tools.js'

const ROOT = '/workspace'

/** In-memory FsBackend, standing in for a real disk. `symlinks` maps a path (or path prefix) to the real target it resolves to, simulating a symlink escape for the realpath check. */
function makeFakeBackend(opts: { symlinks?: Record<string, string> } = {}): FsBackend {
  const files = new Map<string, string>()
  const dirs = new Set<string>([ROOT])
  const symlinks = new Map(Object.entries(opts.symlinks ?? {}))

  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir(path) {
      dirs.add(path)
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
    async realpath(path) {
      for (const [link, target] of symlinks) {
        if (path === link) return target
        if (path.startsWith(`${link}/`)) return target + path.slice(link.length)
      }
      if (files.has(path) || dirs.has(path)) return path
      throw new Error(`ENOENT: ${path}`)
    },
    // test helpers, not part of FsBackend
    _files: files,
    _dirs: dirs,
  } as FsBackend & { _files: Map<string, string>; _dirs: Set<string> }
}

describe('resolveInWorkspace', () => {
  it('resolves a plain relative path against the root', () => {
    expect(resolveInWorkspace(ROOT, 'notes/summary.md')).toBe('/workspace/notes/summary.md')
  })

  it('resolves an absolute path that is inside the root', () => {
    expect(resolveInWorkspace(ROOT, '/workspace/notes/summary.md')).toBe('/workspace/notes/summary.md')
  })

  it('rejects ../ traversal that escapes the root', () => {
    expect(() => resolveInWorkspace(ROOT, '../../etc/passwd')).toThrow(PathOutsideWorkspaceError)
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveInWorkspace(ROOT, '/etc/passwd')).toThrow(PathOutsideWorkspaceError)
  })

  it('allows a relative path that dips into ../ but nets back inside the root', () => {
    expect(resolveInWorkspace(ROOT, 'notes/../summary.md')).toBe('/workspace/summary.md')
  })
})

describe('executeFileTool', () => {
  it('read_file returns the real content of a file inside the workspace', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/notes.txt`, 'hello world')
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    const result = await executeFileTool(ctx, 'read_file', { path: 'notes.txt' })
    expect(result).toEqual({ kind: 'text', text: 'hello world' })
  })

  it('read_file rejects a traversal path with no I/O attempted', async () => {
    const backend = makeFakeBackend()
    const spy = vi.spyOn(backend, 'readTextFile')
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    await expect(executeFileTool(ctx, 'read_file', { path: '../../etc/passwd' })).rejects.toThrow(PathOutsideWorkspaceError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('read_file rejects an absolute path outside the workspace', async () => {
    const backend = makeFakeBackend()
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    await expect(executeFileTool(ctx, 'read_file', { path: '/etc/passwd' })).rejects.toThrow(PathOutsideWorkspaceError)
  })

  it('rejects a symlink inside the workspace that points outside it (realpath check)', async () => {
    const backend = makeFakeBackend({ symlinks: { '/workspace/escape-link': '/etc' } })
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    await expect(executeFileTool(ctx, 'read_file', { path: 'escape-link/passwd' })).rejects.toThrow(PathOutsideWorkspaceError)
  })

  it('list_directory returns real file names inside the workspace', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/a.txt`, '1')
    await backend.writeTextFile(`${ROOT}/b.txt`, '2')
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    const result = await executeFileTool(ctx, 'list_directory', { path: '.' })
    expect(result.kind).toBe('text')
    expect((result as { text: string }).text.split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('write_file never calls backend.writeTextFile — it only stages', async () => {
    const backend = makeFakeBackend()
    const writeSpy = vi.spyOn(backend, 'writeTextFile')
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    const result = await executeFileTool(ctx, 'write_file', { path: 'notes/summary.md', content: 'draft content' })

    expect(result.kind).toBe('staged_write')
    expect(await backend.readTextFile(`${ROOT}/notes/summary.md`)).toBeUndefined()
    // The only writeTextFile call should be the staging record itself, not the real target.
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toContain('.pending-actions/')
  })

  it('write_file rejects and stages nothing for an out-of-scope path', async () => {
    const backend = makeFakeBackend()
    const ctx: FileToolsContext = { backend, workspaceRoot: ROOT }

    await expect(executeFileTool(ctx, 'write_file', { path: '../../etc/passwd', content: 'x' })).rejects.toThrow(
      PathOutsideWorkspaceError,
    )
    expect(await backend.readDir(`${ROOT}/.pending-actions`)).toEqual([])
  })
})

describe('pending-action staging', () => {
  it('stagePendingAction writes a write-kind record that loadPendingAction can read back', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'write', path: 'notes/summary.md', content: 'draft' })

    const record = await loadPendingAction(backend, ROOT, id)
    expect(record).toMatchObject({ id, kind: 'write', path: 'notes/summary.md', content: 'draft' })
    expect(record?.stagedAt).toBeTruthy()
  })

  it('stagePendingAction writes a shell-kind record that loadPendingAction can read back', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'shell', command: 'ls -la', cwd: ROOT })

    const record = await loadPendingAction(backend, ROOT, id)
    expect(record).toMatchObject({ id, kind: 'shell', command: 'ls -la', cwd: ROOT })
  })

  it('applyPendingAction writes exactly the staged content and deletes the staging record for kind: write', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'write', path: 'notes/summary.md', content: 'final content' })

    const applied = await applyPendingAction(backend, ROOT, id)

    expect(applied.kind).toBe('write')
    expect((applied as { content: string }).content).toBe('final content')
    expect(await backend.readTextFile(`${ROOT}/notes/summary.md`)).toBe('final content')
    expect(await loadPendingAction(backend, ROOT, id)).toBeUndefined()
  })

  it('applyPendingAction throws for an unknown id and writes nothing', async () => {
    const backend = makeFakeBackend()
    await expect(applyPendingAction(backend, ROOT, 'no-such-id')).rejects.toThrow()
  })

  it('applyPendingAction throws for a staged shell action with no executeShell callback provided', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'shell', command: 'echo hi', cwd: ROOT })

    await expect(applyPendingAction(backend, ROOT, id)).rejects.toThrow(/executeShell/)
  })

  it('applyPendingAction clears the shell result cache once a write actually lands (h4/convF)', async () => {
    // A cached `ls` result predates the write below — it must not survive to be served as if it
    // still reflected the current (now-changed) workspace state.
    const backend = makeFakeBackend()
    await recordShellCacheEntry(backend, ROOT, {
      command: 'ls',
      cwd: ROOT,
      execution: { output: '', exitCode: 0, timedOut: false },
      resolvedAt: new Date().toISOString(),
    })
    expect(await findCachedShellResult(backend, ROOT, 'ls', ROOT)).toBeDefined()

    const { id } = await stagePendingAction(backend, ROOT, { kind: 'write', path: 'note.txt', content: 'hello world' })
    await applyPendingAction(backend, ROOT, id)

    expect(await findCachedShellResult(backend, ROOT, 'ls', ROOT)).toBeUndefined()
  })

  it('applyPendingAction invokes the injected executeShell callback for kind: shell and deletes the staging record', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'shell', command: 'echo hi', cwd: ROOT })

    const executeShell = vi.fn().mockResolvedValue({ output: 'hi\n', exitCode: 0, timedOut: false })
    const applied = await applyPendingAction(backend, ROOT, id, { executeShell })

    expect(executeShell).toHaveBeenCalledWith('echo hi', ROOT)
    expect(applied).toMatchObject({ kind: 'shell', execution: { output: 'hi\n', exitCode: 0, timedOut: false } })
    expect(await loadPendingAction(backend, ROOT, id)).toBeUndefined()
  })

  it('discardPendingAction deletes the staging record and performs no write', async () => {
    const backend = makeFakeBackend()
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'write', path: 'notes/summary.md', content: 'never applied' })

    await discardPendingAction(backend, ROOT, id)

    expect(await loadPendingAction(backend, ROOT, id)).toBeUndefined()
    expect(await backend.readTextFile(`${ROOT}/notes/summary.md`)).toBeUndefined()
  })
})
