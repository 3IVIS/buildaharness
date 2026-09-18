import { describe, it, expect, vi } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { executeShellTool, commandMayLeaveWorkspace, type ShellStagingContext } from './shell-tools.js'
import { PathOutsideWorkspaceError, loadPendingAction, discardPendingAction } from './file-tools.js'

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

describe('executeShellTool — always stages, never caches', () => {
  it('stages a fresh approval for an identical (command, cwd) repeat rather than reusing a prior result', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ShellStagingContext = { backend, workspaceRoot: ROOT }

    const first = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi' })
    const second = await executeShellTool(ctx, 'run_shell_command', { command: 'echo hi' })

    expect(first.kind).toBe('staged_shell')
    expect(second.kind).toBe('staged_shell')
    if (first.kind !== 'staged_shell' || second.kind !== 'staged_shell') throw new Error('unreachable')
    expect(second.id).not.toBe(first.id)
  })
})

describe('commandMayLeaveWorkspace (conv06 batch finding: cwd validation does not contain the command itself)', () => {
  it('flags a relative parent-directory reference', () => {
    expect(commandMayLeaveWorkspace('mkdir -p ../outside-workspace-test')).toBe(true)
    expect(commandMayLeaveWorkspace('cd .. && rm file')).toBe(true)
    expect(commandMayLeaveWorkspace('cat ../../etc/passwd')).toBe(true)
  })

  it('does not flag ordinary commands with no parent-directory segment', () => {
    expect(commandMayLeaveWorkspace('ls -la')).toBe(false)
    expect(commandMayLeaveWorkspace('echo hello')).toBe(false)
    expect(commandMayLeaveWorkspace("git log --format='%H'")).toBe(false)
  })

  it('does not false-positive on ".." appearing without a path-segment boundary', () => {
    // A commit-range-shaped token ("HEAD~1..HEAD") or a plain string containing ".." mid-word
    // should not trip the heuristic — it's specifically about a `..` path segment.
    expect(commandMayLeaveWorkspace('git diff HEAD~1..HEAD')).toBe(false)
    expect(commandMayLeaveWorkspace("echo '2..3'")).toBe(false)
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
