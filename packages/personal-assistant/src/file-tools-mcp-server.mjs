#!/usr/bin/env node
/**
 * MCP stdio server exposing read_file/list_directory/write_file to the Claude CLI —
 * the same MCP mechanism already proven for the coaching/planner agents (see
 * adapter/agents/coaching/mcp_server.py, adapter/agents/planner/mcp_server.py: both
 * FastMCP stdio servers started via --mcp-config, alongside --dangerously-skip-permissions
 * so a headless `claude -p` call can actually invoke them without an interactive
 * permission prompt — this server is started the same way, for the same reason).
 *
 * This file is plain Node ESM, not TypeScript: it's spawned directly via `node`
 * by ClaudeCliLLMClient, independent of this package's vite build, so it can't
 * statically import file-tools.ts's compiled output. It re-implements the same
 * sandboxing algorithm as file-tools.ts's resolveInWorkspace/assertRealPathInWorkspace
 * — keep the two in sync if either changes (the `--test` self-check below guards
 * against the sandbox logic silently drifting).
 *
 * Started as a subprocess by the Claude CLI via --mcp-config:
 *   {
 *     "mcpServers": {
 *       "file-tools": {
 *         "command": "node",
 *         "args": ["/abs/path/to/file-tools-mcp-server.mjs"],
 *         "env": { "WORKSPACE_ROOT": "/abs/path/to/workspace" }
 *       }
 *     }
 *   }
 *
 * write_file never touches the real file — it only stages a proposal under
 * <WORKSPACE_ROOT>/.pending-writes/<id>.json, in the exact same record shape
 * file-tools.ts's stagePendingWrite/applyPendingWrite/discardPendingWrite use, so
 * PersonalAssistant can apply or discard it once the user approves or declines.
 * The gate lives inside this tool implementation, not in a wrapper around it:
 * once --mcp-config is active, Claude Code's own agentic loop calls these tools
 * autonomously within a single `claude -p` invocation, so there's no outer loop
 * left to intercept the call before it happens.
 *
 * Self-test (exercises the sandbox + staging logic without a real MCP client
 * attached over stdio): node file-tools-mcp-server.mjs --test
 */

import { readFile, writeFile, mkdir, readdir, realpath as fsRealpath, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const PENDING_WRITES_DIR = '.pending-writes'

export class PathOutsideWorkspaceError extends Error {
  constructor(requestedPath) {
    super(`Path "${requestedPath}" resolves outside the workspace root.`)
    this.name = 'PathOutsideWorkspaceError'
  }
}

function normalizePath(path) {
  const absolute = path.startsWith('/')
  const segments = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!absolute) segments.push('..')
    } else {
      segments.push(part)
    }
  }
  return (absolute ? '/' : '') + segments.join('/')
}

export function resolveInWorkspace(workspaceRoot, requestedPath) {
  const root = normalizePath(workspaceRoot)
  const combined = requestedPath.startsWith('/') ? requestedPath : `${root}/${requestedPath}`
  const resolved = normalizePath(combined)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new PathOutsideWorkspaceError(requestedPath)
  }
  return resolved
}

async function realpathOfNearestExistingAncestor(path) {
  try {
    return await fsRealpath(path)
  } catch {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    if (parent === path) return path
    const realParent = await realpathOfNearestExistingAncestor(parent)
    return `${realParent}${path.slice(parent.length)}`
  }
}

async function assertRealPathInWorkspace(workspaceRoot, resolvedPath) {
  const realRoot = await fsRealpath(workspaceRoot).catch(() => workspaceRoot)
  const realTarget = await realpathOfNearestExistingAncestor(resolvedPath)
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new PathOutsideWorkspaceError(resolvedPath)
  }
}

async function resolveAndVerify(workspaceRoot, requestedPath) {
  const resolved = resolveInWorkspace(workspaceRoot, requestedPath)
  await assertRealPathInWorkspace(workspaceRoot, resolved)
  return resolved
}

function isEnoent(err) {
  return err?.code === 'ENOENT'
}

export async function stagePendingWrite(workspaceRoot, { path, content }) {
  const id = randomUUID()
  const record = { id, path, content, stagedAt: new Date().toISOString() }
  const dir = `${workspaceRoot}/${PENDING_WRITES_DIR}`
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/${id}.json`, JSON.stringify(record), 'utf-8')
  return { id }
}

async function main() {
  const workspaceRoot = process.env.WORKSPACE_ROOT
  if (!workspaceRoot) {
    console.error('file-tools-mcp-server: WORKSPACE_ROOT env var is required')
    process.exit(1)
  }

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({ name: 'file-tools', version: '1.0.0' })

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file inside the sandboxed workspace directory. `path` is relative to the workspace root ' +
        '(or an absolute path that is still inside it) — any path outside the workspace is rejected.',
      inputSchema: { path: z.string().describe('File path to read.') },
    },
    async ({ path }) => {
      try {
        const resolved = await resolveAndVerify(workspaceRoot, path)
        const content = await readFile(resolved, 'utf-8').catch((err) => {
          if (isEnoent(err)) return undefined
          throw err
        })
        if (content === undefined) return { content: [{ type: 'text', text: `File not found: ${path}` }], isError: true }
        return { content: [{ type: 'text', text: content }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'list_directory',
    {
      description:
        'List file and directory names inside a directory in the sandboxed workspace, non-recursive. ' +
        '`path` is relative to the workspace root — any path outside the workspace is rejected.',
      inputSchema: { path: z.string().describe('Directory path to list.') },
    },
    async ({ path }) => {
      try {
        const resolved = await resolveAndVerify(workspaceRoot, path)
        const names = await readdir(resolved).catch((err) => {
          if (isEnoent(err)) return []
          throw err
        })
        return { content: [{ type: 'text', text: names.join('\n') }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'write_file',
    {
      description:
        'Propose writing text content to a file inside the sandboxed workspace. This never writes immediately — ' +
        'it stages the proposal for the user to explicitly approve or decline before anything touches disk. ' +
        '`path` outside the workspace is rejected immediately, before anything is staged.',
      inputSchema: {
        path: z.string().describe('File path to write.'),
        content: z.string().describe('Full text content to write to the file.'),
      },
    },
    async ({ path, content }) => {
      try {
        // Validate now — an out-of-scope path fails immediately, never gets staged.
        await resolveAndVerify(workspaceRoot, path)
        const { id } = await stagePendingWrite(workspaceRoot, { path, content })
        return {
          content: [
            { type: 'text', text: `Staged a write to "${path}" (id: ${id}). Nothing has been written yet — it needs the user's approval.` },
          ],
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function selfTest() {
  const dir = await mkdtemp(`${tmpdir()}/file-tools-mcp-test-`)
  try {
    const resolved = resolveInWorkspace(dir, 'notes.txt')
    if (resolved !== `${dir}/notes.txt`) throw new Error('resolveInWorkspace failed for a plain relative path')

    try {
      resolveInWorkspace(dir, '../../etc/passwd')
      throw new Error('resolveInWorkspace should have rejected a traversal path')
    } catch (err) {
      if (!(err instanceof PathOutsideWorkspaceError)) throw err
    }

    const { id } = await stagePendingWrite(dir, { path: 'notes.txt', content: 'hello' })
    const staged = JSON.parse(await readFile(`${dir}/${PENDING_WRITES_DIR}/${id}.json`, 'utf-8'))
    if (staged.content !== 'hello') throw new Error('staged record missing expected content')

    console.log(`OK — resolveInWorkspace and stagePendingWrite behave as expected (id: ${id})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv.includes('--test')) {
  await selfTest()
} else {
  await main()
}
