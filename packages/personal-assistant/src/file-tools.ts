import type { FsBackend, ToolDefinition } from '@buildaharness/runtime'

/**
 * Thrown by resolveInWorkspace/assertRealPathInWorkspace instead of returning
 * a falsy value, so callers can't accidentally proceed past a rejected path.
 */
export class PathOutsideWorkspaceError extends Error {
  constructor(public readonly requestedPath: string) {
    super(`Path "${requestedPath}" resolves outside the workspace root.`)
    this.name = 'PathOutsideWorkspaceError'
  }
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!absolute) segments.push('..')
      // else: '..' past an absolute root is a no-op, matching real filesystem semantics
    } else {
      segments.push(part)
    }
  }
  return (absolute ? '/' : '') + segments.join('/')
}

/**
 * Resolves `requestedPath` against `workspaceRoot` and rejects anything that
 * escapes it (`../` traversal, or an absolute path outside the root). Purely
 * string-based — no real filesystem access, no node:path — so this module has
 * no environment-specific dependency and stays safe to import from assistant.ts,
 * which is bundled into both the Node CLI and the browser (chat-ui) builds.
 *
 * This alone cannot catch a symlink *inside* the workspace that points outside
 * it; see assertRealPathInWorkspace for that (needs real I/O via FsBackend).
 */
export function resolveInWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = normalizePath(workspaceRoot)
  const combined = requestedPath.startsWith('/') ? requestedPath : `${root}/${requestedPath}`
  const resolved = normalizePath(combined)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new PathOutsideWorkspaceError(requestedPath)
  }
  return resolved
}

async function realpathOfNearestExistingAncestor(backend: FsBackend, path: string): Promise<string> {
  if (!backend.realpath) return path
  try {
    return await backend.realpath(path)
  } catch {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    if (parent === path) return path
    const realParent = await realpathOfNearestExistingAncestor(backend, parent)
    return `${realParent}${path.slice(parent.length)}`
  }
}

/**
 * Defense in depth beyond resolveInWorkspace's string-prefix check: resolves
 * symlinks (via the injected backend's optional `realpath`) on the nearest
 * existing ancestor of `resolvedPath` and re-verifies it's still under the
 * workspace root's real path. A no-op (best-effort only) if the backend
 * doesn't implement `realpath`.
 */
export async function assertRealPathInWorkspace(backend: FsBackend, workspaceRoot: string, resolvedPath: string): Promise<void> {
  if (!backend.realpath) return

  const realRoot = await backend.realpath(workspaceRoot).catch(() => workspaceRoot)
  const realTarget = await realpathOfNearestExistingAncestor(backend, resolvedPath)

  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new PathOutsideWorkspaceError(resolvedPath)
  }
}

async function resolveAndVerify(ctx: FileToolsContext, requestedPath: string): Promise<string> {
  const resolved = resolveInWorkspace(ctx.workspaceRoot, requestedPath)
  await assertRealPathInWorkspace(ctx.backend, ctx.workspaceRoot, resolved)
  return resolved
}

export const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a text file inside the sandboxed workspace directory. `path` is relative to the workspace root ' +
    '(or an absolute path that is still inside it) — any path outside the workspace is rejected.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path to read.' } },
    required: ['path'],
  },
}

export const LIST_DIRECTORY_TOOL: ToolDefinition = {
  name: 'list_directory',
  description:
    'List file and directory names inside a directory in the sandboxed workspace, non-recursive. ' +
    '`path` is relative to the workspace root — any path outside the workspace is rejected.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path to list.' } },
    required: ['path'],
  },
}

export const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description:
    'Propose writing text content to a file inside the sandboxed workspace. This never writes immediately — ' +
    'it stages the proposal for the user to explicitly approve or decline before anything touches disk. ' +
    '`path` outside the workspace is rejected immediately, before anything is staged.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write.' },
      content: { type: 'string', description: 'Full text content to write to the file.' },
    },
    required: ['path', 'content'],
  },
}

export const FILE_TOOLS: ToolDefinition[] = [READ_FILE_TOOL, LIST_DIRECTORY_TOOL, WRITE_FILE_TOOL]

export interface FileToolsContext {
  backend: FsBackend
  workspaceRoot: string
}

export type FileToolResult =
  | { kind: 'text'; text: string }
  | { kind: 'staged_write'; id: string; path: string; content: string }

export function requireStringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`"${key}" argument must be a string`)
  return value
}

/** Executes one of the three file tools by name. Real I/O for read/list; write_file only stages (see T2). */
export async function executeFileTool(ctx: FileToolsContext, toolName: string, input: Record<string, unknown>): Promise<FileToolResult> {
  switch (toolName) {
    case 'read_file': {
      const resolved = await resolveAndVerify(ctx, requireStringArg(input, 'path'))
      const content = await ctx.backend.readTextFile(resolved)
      if (content === undefined) throw new Error(`File not found: ${input.path as string}`)
      return { kind: 'text', text: content }
    }
    case 'list_directory': {
      const resolved = await resolveAndVerify(ctx, requireStringArg(input, 'path'))
      const names = await ctx.backend.readDir(resolved)
      return { kind: 'text', text: names.join('\n') }
    }
    case 'write_file': {
      const path = requireStringArg(input, 'path')
      const content = requireStringArg(input, 'content')
      // Validate now — a proposal for an out-of-scope path fails immediately
      // rather than getting staged for approval.
      await resolveAndVerify(ctx, path)
      const { id } = await stagePendingWrite(ctx.backend, ctx.workspaceRoot, { path, content })
      return { kind: 'staged_write', id, path, content }
    }
    default:
      throw new Error(`Unknown file tool: ${toolName}`)
  }
}

// ── Pending-write staging (T2) ──────────────────────────────────────────────

export interface PendingWriteRecord {
  id: string
  /** Workspace-relative (or absolute-but-inside-workspace), exactly as the model proposed it. */
  path: string
  content: string
  stagedAt: string
}

const PENDING_WRITES_DIR = '.pending-writes'

function pendingWritesDir(workspaceRoot: string): string {
  return `${workspaceRoot}/${PENDING_WRITES_DIR}`
}

function pendingWritePath(workspaceRoot: string, id: string): string {
  return `${pendingWritesDir(workspaceRoot)}/${id}.json`
}

/** Stages a write for later approval. `id` is a random UUID, not derived from the session — see T4. */
export async function stagePendingWrite(
  backend: FsBackend,
  workspaceRoot: string,
  proposal: { path: string; content: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const record: PendingWriteRecord = { id, path: proposal.path, content: proposal.content, stagedAt: new Date().toISOString() }
  await backend.mkdir(pendingWritesDir(workspaceRoot))
  await backend.writeTextFile(pendingWritePath(workspaceRoot, id), JSON.stringify(record))
  return { id }
}

export async function loadPendingWrite(backend: FsBackend, workspaceRoot: string, id: string): Promise<PendingWriteRecord | undefined> {
  const raw = await backend.readTextFile(pendingWritePath(workspaceRoot, id))
  return raw === undefined ? undefined : (JSON.parse(raw) as PendingWriteRecord)
}

/** Applies a previously staged write for real, then deletes its staging record. Throws if `id` isn't staged. */
export async function applyPendingWrite(backend: FsBackend, workspaceRoot: string, id: string): Promise<PendingWriteRecord> {
  const record = await loadPendingWrite(backend, workspaceRoot, id)
  if (!record) throw new Error(`No pending write staged with id "${id}"`)

  // Defense in depth — the workspace root shouldn't have changed between
  // staging and approval, but don't trust that; re-validate before writing.
  const resolved = resolveInWorkspace(workspaceRoot, record.path)
  await assertRealPathInWorkspace(backend, workspaceRoot, resolved)

  await backend.writeTextFile(resolved, record.content)
  await backend.removeFile(pendingWritePath(workspaceRoot, id))
  return record
}

/** Deletes a staged write without applying it. Used when the user declines. No-op if `id` isn't staged. */
export async function discardPendingWrite(backend: FsBackend, workspaceRoot: string, id: string): Promise<void> {
  await backend.removeFile(pendingWritePath(workspaceRoot, id))
}
