import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsBackend } from '@buildaharness/runtime'
import { executeShellTool, type ShellStagingContext } from './shell-tools.js'
import { loadPendingAction, applyPendingAction } from './file-tools.js'
import { runApprovedShellCommand } from './shell-executor.js'

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

describe('runApprovedShellCommand (real subprocess)', () => {
  it('runs the command with the given cwd and reports stdout + exit code 0', async () => {
    const result = await runApprovedShellCommand('pwd', process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.output.trim()).toBe(process.cwd())
    expect(result.timedOut).toBe(false)
  })

  it('reduces env to the allowlist — an injected secret env var never reaches the command', async () => {
    process.env.ASSISTANT_TEST_SECRET = 'super-secret-value'
    try {
      const result = await runApprovedShellCommand('echo "[$ASSISTANT_TEST_SECRET]"', process.cwd())
      expect(result.output).not.toContain('super-secret-value')
    } finally {
      delete process.env.ASSISTANT_TEST_SECRET
    }
  })

  it('reports a non-zero exit code as a normal outcome, not a thrown error', async () => {
    const result = await runApprovedShellCommand('exit 3', process.cwd())
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  it('kills a command exceeding the timeout and reports it as timed out', async () => {
    const result = await runApprovedShellCommand('sleep 5', process.cwd(), { timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  }, 10_000)

  it('truncates combined stdout/stderr past the byte cap', async () => {
    const result = await runApprovedShellCommand('yes x | head -c 5000', process.cwd(), { maxOutputBytes: 100 })
    expect(result.output.endsWith('(truncated)')).toBe(true)
  })
})

describe('applyPendingAction integration with runApprovedShellCommand', () => {
  it('applying a staged shell action runs the real command in the staged cwd and returns its result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shell-executor-test-'))
    try {
      const backend = makeFakeBackend(dir)
      const ctx: ShellStagingContext = { backend, workspaceRoot: dir }
      const staged = await executeShellTool(ctx, 'run_shell_command', { command: 'echo integration-test-output' })

      const applied = await applyPendingAction(backend, dir, staged.id, {
        executeShell: (command, cwd) => runApprovedShellCommand(command, cwd),
      })

      expect(applied.kind).toBe('shell')
      if (applied.kind !== 'shell') throw new Error('unreachable')
      expect(applied.execution.output.trim()).toBe('integration-test-output')
      expect(applied.execution.exitCode).toBe(0)
      expect(await loadPendingAction(backend, dir, staged.id)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
