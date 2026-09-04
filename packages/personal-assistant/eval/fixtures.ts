/**
 * Per-task workspace + tool-context construction for the benchmark arms. Node-only.
 *
 * The workspace is a **real temp directory** (`os.tmpdir()/bah-eval-<id>-<rand>`), written from
 * the task's `workspace[]` and removed after the turn. Real fs, not a mock — so the assistant's
 * production path-validation / staging / read code runs unchanged, AND the `claude-cli` backend's
 * out-of-process MCP file server (which can only see real files) works against the same directory.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { FsBackend } from '@buildaharness/runtime'
import { createNodeFsBackend } from '../src/node-fs-backend.js'
import type { FileToolsContext } from '../src/file-tools.js'
import type { ShellToolsContext } from '../src/shell-tools.js'
import type { TaskSpec } from './corpus/schema.js'

export interface Workspace {
  /** Absolute path to the temp directory. */
  root: string
  backend: FsBackend
  /** Current content of each declared task path — `null` once deleted. */
  snapshot(paths: string[]): Record<string, string | null>
  cleanup(): void
}

export function makeWorkspace(task: TaskSpec): Workspace {
  const root = mkdtempSync(join(tmpdir(), `bah-eval-${task.id}-`))
  for (const f of task.workspace) {
    const full = join(root, f.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, f.content)
  }
  return {
    root,
    backend: createNodeFsBackend(),
    snapshot(paths) {
      const out: Record<string, string | null> = {}
      for (const p of paths) {
        const full = join(root, p)
        out[p] = existsSync(full) ? readFileSync(full, 'utf8') : null
      }
      return out
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export interface TaskToolContexts {
  fileTools?: FileToolsContext
  shellTools?: ShellToolsContext
}

export function buildToolContexts(task: TaskSpec, ws: Workspace, backend: FsBackend): TaskToolContexts {
  const fileTools = task.tools.file ? { backend, workspaceRoot: ws.root } : undefined
  const shellTools: ShellToolsContext | undefined = task.tools.shell
    ? {
        backend,
        workspaceRoot: ws.root,
        // Never actually run anything — an arm that reaches real execution has already failed the
        // "must stage" grader. This throws so an accidental apply is loud.
        executeCommand: async () => {
          throw new Error('eval: shell execution is not permitted in the benchmark')
        },
      }
    : undefined
  return { fileTools, shellTools }
}

/**
 * Wraps an FsBackend so its first `readTextFile` throws once, then behaves normally — the
 * `injectedFailure: 'first_tool_call_throws'` mechanism. Only affects the assistant's *own*
 * in-process reads (the proxy-backend tool loop); the claude-cli MCP server reads out of process
 * and is unaffected, so this failure mode is only meaningful on the proxy backend today.
 */
export function withFirstReadFailure(backend: FsBackend): { backend: FsBackend; fired: () => boolean } {
  let armed = true
  let fired = false
  const wrapped: FsBackend = {
    ...backend,
    async readTextFile(path) {
      if (armed) {
        armed = false
        fired = true
        throw new Error('eval: injected transient read failure')
      }
      return backend.readTextFile(path)
    },
  }
  return { backend: wrapped, fired: () => fired }
}
