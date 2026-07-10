import { describe, it, expect, vi } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { executeShellTool, type ShellStagingContext } from './shell-tools.js'
import { PathOutsideWorkspaceError, loadPendingAction, discardPendingAction, recordShellCacheEntry, clearShellCache } from './file-tools.js'

/** In-memory FsBackend, standing in for a real disk — mirrors file-tools.test.ts's fake. */
function makeFakeBackend(root: string): FsBackend {
  const files = new Map<string, string>()
  const dirs = new Set<string>([root])
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
      if (files.has(path) || dirs.has(path)) return path
      throw new Error(`ENOENT: ${path}`)
    },
  }
}

const ROOT = '/workspace'

describe('executeShellTool', () => {
  it('never spawns anything — only stages a pending action', async () => {
    const backend = makeFakeBackend(ROOT)
    const writeSpy = vi.spyOn(backend, 'writeTextFile')
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }

    const result = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi' })
    if (result.kind !== 'staged_shell') throw new Error('expected a fresh command to stage, not a cache hit')

    expect(result.kind).toBe('staged_shell')
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toContain('.pending-actions/')

    const record = await loadPendingAction(backend, ROOT, result.id)
    expect(record).toMatchObject({ kind: 'shell', command: 'echo hi', cwd: ROOT })
  })

  it('rejects a cwd outside the workspace immediately, staging nothing', async () => {
    const backend = makeFakeBackend(ROOT)
    const writeSpy = vi.spyOn(backend, 'writeTextFile')
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }

    await expect(executeShellTool(ctx, 'run_shell_command', { command: 'ls', cwd: '../../etc' })).rejects.toThrow(
      PathOutsideWorkspaceError,
    )
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('defaults cwd to the workspace root when not provided', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }

    const result = await executeShellTool(ctx, 'run_shell_command', { command: 'pwd' })

    expect(result.cwd).toBe(ROOT)
  })

  it('resolves a cwd nested inside the workspace', async () => {
    const backend = makeFakeBackend(ROOT)
    await backend.mkdir(`${ROOT}/sub`)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }

    const result = await executeShellTool(ctx, 'run_shell_command', { command: 'ls', cwd: 'sub' })

    expect(result.cwd).toBe(`${ROOT}/sub`)
  })
})

describe('executeShellTool — shell result cache (conv4/12/21 shell-reuse finding)', () => {
  it('answers an identical (command, cwd) repeat from cache instead of staging a new approval', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }
    await recordShellCacheEntry(backend, ROOT, {
      command: 'echo hi',
      cwd: ROOT,
      execution: { output: 'hi\n', exitCode: 0, timedOut: false },
      resolvedAt: new Date().toISOString(),
    })
    const writeSpy = vi.spyOn(backend, 'writeTextFile')

    const result = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi' })

    expect(result.kind).toBe('cached_shell')
    if (result.kind !== 'cached_shell') throw new Error('unreachable')
    expect(result.execution.output).toBe('hi\n')
    // No new pending action written — a cache hit must not also stage.
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('does not match a different command or a different cwd', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }
    await backend.mkdir(`${ROOT}/sub`)
    await recordShellCacheEntry(backend, ROOT, {
      command: 'echo hi',
      cwd: ROOT,
      execution: { output: 'hi\n', exitCode: 0, timedOut: false },
      resolvedAt: new Date().toISOString(),
    })

    const differentCommand = await executeShellTool(ctx, 'run_shell_command', { command: 'echo bye' })
    expect(differentCommand.kind).toBe('staged_shell')

    const differentCwd = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi', cwd: 'sub' })
    expect(differentCwd.kind).toBe('staged_shell')
  })

  it('clearShellCache removes cached entries so the same command stages again', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }
    await recordShellCacheEntry(backend, ROOT, {
      command: 'echo hi',
      cwd: ROOT,
      execution: { output: 'hi\n', exitCode: 0, timedOut: false },
      resolvedAt: new Date().toISOString(),
    })

    await clearShellCache(backend, ROOT)

    const result = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi' })
    expect(result.kind).toBe('staged_shell')
  })
})

describe('discardPendingAction (kind: shell)', () => {
  it('deletes the staged record without ever spawning anything', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }
    const staged = await executeShellTool(ctx, 'run_shell_command', { command: 'rm -rf /' })
    if (staged.kind !== 'staged_shell') throw new Error('expected a fresh command to stage, not a cache hit')

    await discardPendingAction(backend, ROOT, staged.id)

    expect(await loadPendingAction(backend, ROOT, staged.id)).toBeUndefined()
  })
})
