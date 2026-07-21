import type { FsBackend, ToolDefinition } from '@buildaharness/runtime'
import {
  snapshotBeforeWrite,
  snapshotWorkspaceTree,
  buildShellUndoLogEntry,
  recordUndoLogEntry,
  deleteUndoLogEntry,
  type UndoLogEntry,
} from './action-snapshot.js'

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
    '`path` outside the workspace is rejected immediately, before anything is staged. Do NOT call this to check ' +
    'or verify what a file currently contains — that is a read, not a write, and re-proposing the same write ' +
    'just to answer a question about existing content forces a pointless second approval prompt. Use read_file ' +
    'for that instead (or answer directly if you already know the content from a write earlier in this ' +
    'conversation).',
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
      const { id } = await stagePendingAction(ctx.backend, ctx.workspaceRoot, { kind: 'write', path, content })
      return { kind: 'staged_write', id, path, content }
    }
    default:
      throw new Error(`Unknown file tool: ${toolName}`)
  }
}

// ── Pending-action staging (generalized from pending-write staging, T2 of the file-tools plan) ──

export type PendingActionPayload =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'shell'; command: string; cwd: string }
  /**
   * Staged by /undo-action (T3), never by the model — reverts a previously-applied write/shell
   * action back to its pre-action state. `revertedEntryId` names the undo-log entry this reverts
   * (deleted once applied — see applyPendingAction's revert branch). `restore`/`remove` are the
   * concrete filesystem operations (see action-snapshot.ts's buildRevertPlan), computed once at
   * staging time so apply doesn't need to re-derive them from a (possibly since-pruned) undo-log
   * entry.
   */
  | { kind: 'revert'; revertedEntryId: string; restore: { path: string; content: string }[]; remove: string[] }

export type PendingActionRecord = { id: string; stagedAt: string } & PendingActionPayload

/** Result of actually running a previously staged shell command — see shell-executor.ts. */
export interface ShellExecutionResult {
  /** Combined stdout+stderr, truncated to a byte cap. */
  output: string
  exitCode: number | null
  timedOut: boolean
}

export type ApplyPendingActionResult =
  | ({ kind: 'write' } & PendingActionRecord)
  | ({ kind: 'shell' } & PendingActionRecord & { execution: ShellExecutionResult })
  | ({ kind: 'revert' } & PendingActionRecord)

const PENDING_ACTIONS_DIR = '.pending-actions'

function pendingActionsDir(workspaceRoot: string): string {
  return `${workspaceRoot}/${PENDING_ACTIONS_DIR}`
}

function pendingActionPath(workspaceRoot: string, id: string): string {
  return `${pendingActionsDir(workspaceRoot)}/${id}.json`
}

/** Stages an action for later approval. `id` is a random UUID, not derived from the session — see T4 of the file-tools plan. */
export async function stagePendingAction(
  backend: FsBackend,
  workspaceRoot: string,
  payload: PendingActionPayload,
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const record: PendingActionRecord = { id, stagedAt: new Date().toISOString(), ...payload }
  await backend.mkdir(pendingActionsDir(workspaceRoot))
  await backend.writeTextFile(pendingActionPath(workspaceRoot, id), JSON.stringify(record))
  return { id }
}

export async function loadPendingAction(backend: FsBackend, workspaceRoot: string, id: string): Promise<PendingActionRecord | undefined> {
  const raw = await backend.readTextFile(pendingActionPath(workspaceRoot, id))
  return raw === undefined ? undefined : (JSON.parse(raw) as PendingActionRecord)
}

/**
 * Applies a previously staged action for real, then deletes its staging record. Throws if `id`
 * isn't staged. `kind: 'write'` is applied directly (pure FsBackend I/O, safe in any environment
 * this package runs in). `kind: 'shell'` requires an injected `executeShell` callback instead of
 * this module spawning a process itself — file-tools.ts has no Node dependency of its own (it's
 * bundled into the browser build via assistant.ts/index.ts), so the real child_process.spawn call
 * lives in shell-executor.ts and is only ever wired in by Node-only callers (cli.ts).
 */
export async function applyPendingAction(
  backend: FsBackend,
  workspaceRoot: string,
  id: string,
  options: { executeShell?: (command: string, cwd: string) => Promise<ShellExecutionResult> } = {},
): Promise<ApplyPendingActionResult> {
  const record = await loadPendingAction(backend, workspaceRoot, id)
  if (!record) throw new Error(`No pending action staged with id "${id}"`)

  if (record.kind === 'revert') {
    // Deliberately does NOT call snapshotBeforeWrite/snapshotWorkspaceTree the way the write/shell
    // branches below do — a revert is one-shot and must never itself produce a new undo-log entry
    // (T3 step 3). Applying it directly, bypassing both snapshot hooks entirely, is what keeps that
    // guarantee true structurally rather than by convention.
    for (const { path, content } of record.restore) {
      const resolved = resolveInWorkspace(workspaceRoot, path)
      await assertRealPathInWorkspace(backend, workspaceRoot, resolved)
      await backend.writeTextFile(resolved, content)
    }
    for (const path of record.remove) {
      const resolved = resolveInWorkspace(workspaceRoot, path)
      await assertRealPathInWorkspace(backend, workspaceRoot, resolved)
      await backend.removeFile(resolved)
    }
    await deleteUndoLogEntry(backend, workspaceRoot, record.revertedEntryId)
    await backend.removeFile(pendingActionPath(workspaceRoot, id))
    // Mirror-direction of the write/shell branches' own clearShellCache() call below — a revert
    // is a workspace mutation exactly like the write/shell action it undoes, so a cached command
    // result from AFTER the original action could otherwise be served as current after reverting
    // it. Same reasoning as that comment, applied in the opposite direction (see T4).
    await clearShellCache(backend, workspaceRoot)
    return record as ApplyPendingActionResult
  }

  if (record.kind === 'write') {
    // Defense in depth — the workspace root shouldn't have changed between
    // staging and approval, but don't trust that; re-validate before writing.
    const resolved = resolveInWorkspace(workspaceRoot, record.path)
    await assertRealPathInWorkspace(backend, workspaceRoot, resolved)

    // Capture what's there now, before it's gone — the only chance to ever undo this write.
    const snapshot = await snapshotBeforeWrite(backend, workspaceRoot, resolved)
    const undoEntryBase = {
      id: crypto.randomUUID(),
      appliedActionId: id,
      kind: 'write' as const,
      path: record.path,
      appliedAt: new Date().toISOString(),
    }
    const undoEntry: UndoLogEntry = snapshot.undoable
      ? { ...undoEntryBase, undoable: true, previousContent: snapshot.previousContent }
      : { ...undoEntryBase, undoable: false, reason: snapshot.reason }
    await recordUndoLogEntry(backend, workspaceRoot, undoEntry)

    await backend.writeTextFile(resolved, record.content)
    await backend.removeFile(pendingActionPath(workspaceRoot, id))
    // The shell result cache below assumes an identical (command, cwd) pair keeps producing the
    // same result — true only as long as nothing else in the workspace changed in between. A
    // write landing here breaks that assumption for every previously-cached command (not just
    // ones that obviously touch this file), so any prior entries must be treated as stale — found
    // via live testing: `ls` (empty workspace) cached, then a file written, then the identical
    // `ls` re-run still served the stale pre-write "no output" result with no re-execution and no
    // approval prompt at all, presented as if it were current.
    await clearShellCache(backend, workspaceRoot)
    return record as ApplyPendingActionResult
  }

  if (!options.executeShell) {
    throw new Error(`Cannot apply a staged shell action ("${id}") — no executeShell callback was provided`)
  }
  // A shell command's effects aren't scoped to one known path the way a write's are — snapshot
  // the whole tree before and after, so the diff (whatever it turns out to be) can still be
  // reverted later. See action-snapshot.ts's snapshotWorkspaceTree/buildShellUndoLogEntry.
  const before = await snapshotWorkspaceTree(backend, workspaceRoot)
  const execution = await options.executeShell(record.command, record.cwd)
  const after = await snapshotWorkspaceTree(backend, workspaceRoot)
  const undoEntry = buildShellUndoLogEntry(id, record.command, before, after)
  await recordUndoLogEntry(backend, workspaceRoot, undoEntry)
  await backend.removeFile(pendingActionPath(workspaceRoot, id))
  return { ...record, execution }
}

/** Deletes a staged action without applying it. Used when the user declines. No-op if `id` isn't staged. */
export async function discardPendingAction(backend: FsBackend, workspaceRoot: string, id: string): Promise<void> {
  await backend.removeFile(pendingActionPath(workspaceRoot, id))
}

/**
 * A staged action left behind by a crashed or abandoned turn is harmless (never applied without
 * its matching id — see applyPendingAction) but, left unswept, accumulates forever. Records older
 * than this are considered abandoned rather than legitimately pending — mirrors the naming
 * convention of action-snapshot.ts's UNDO_LOG_MAX_ENTRIES (T12 of the gap-coverage plan).
 */
export const PENDING_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Deletes `.pending-actions/` records older than `PENDING_ACTION_MAX_AGE_MS`. Called from
 * PersonalAssistant's startup sweep (see assistant.ts), which is itself responsible for first
 * confirming no session has a checkpoint still eligible for resume — this function only applies
 * the age cutoff and has no knowledge of checkpoints itself. `now` is a parameter (not read
 * directly from Date.now()) so tests can pin a fixed reference time. Corrupt records are left in
 * place rather than swept — not this function's job to repair malformed JSON.
 */
export async function sweepAbandonedPendingActions(
  backend: FsBackend,
  workspaceRoot: string,
  now: number = Date.now(),
): Promise<{ swept: string[] }> {
  const dir = pendingActionsDir(workspaceRoot)
  const names = await backend.readDir(dir)
  const swept: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = `${dir}/${name}`
    const raw = await backend.readTextFile(path)
    if (raw === undefined) continue
    let record: PendingActionRecord
    try {
      record = JSON.parse(raw) as PendingActionRecord
    } catch {
      continue
    }
    if (now - new Date(record.stagedAt).getTime() > PENDING_ACTION_MAX_AGE_MS) {
      await backend.removeFile(path)
      swept.push(record.id)
    }
  }
  return { swept }
}

// ── Shell result cache (conv4/12/21's shell-reuse finding) ──────────────────────
//
// Two prior batches tried fixing "a follow-up question re-runs an already-approved shell command
// instead of answering from context" purely with SYSTEM_PROMPT/tool-description wording — both
// held up in that batch's own live testing but failed independent reliability re-testing (the
// re-trigger still reproduced ~1-in-3 to ~2-in-3 runs). Root cause (see conv21): the claude-cli
// backend flattens the whole transcript to plain text per turn (a fresh, stateless `claude -p`
// subprocess every time), discarding any tool-call/tool-result structure that would otherwise
// signal "this claim was already tool-grounded" — so the model periodically re-invokes the tool
// anyway. A deterministic cache removes the model's judgment from the equation entirely: an
// identical (command, cwd) pair already resolved this session answers from the cached result
// instead of ever staging a new approval, no matter what the model decides to do.
//
// File-backed (not in-memory) for the same reason reminders.json is: the claude-cli backend's
// run_shell_command handler lives in a separate, freshly-spawned Node subprocess
// (file-tools-mcp-server.mjs) with no access to this process's memory — see that file's mirrored
// read-only copy of loadShellCache/findCachedShellResult, kept in sync by hand. Only
// applyPendingAction's shell branch (below, via assistant.ts's resolvePendingAction) ever WRITES
// an entry, since that's the only place a shell command is actually executed for real, regardless
// of which backend proposed it — the MCP server only ever stages, never executes.
//
// Cleared on /new (assistant.ts's clearSession) — a fresh conversation shouldn't silently answer
// from a previous, unrelated conversation's shell results.

const SHELL_CACHE_DIR = '.shell-cache'
const SHELL_CACHE_FILE = 'cache.json'

export interface ShellCacheEntry {
  command: string
  cwd: string
  execution: ShellExecutionResult
  resolvedAt: string
}

function shellCachePath(workspaceRoot: string): string {
  return `${workspaceRoot}/${SHELL_CACHE_DIR}/${SHELL_CACHE_FILE}`
}

// A command whose output is expected to change on every invocation (current time, randomness)
// must never be served from the cache — found via live testing: `date +%s%N` run twice in a row
// (the second time via an explicit "run that exact same command again" request) returned the
// FIRST run's stale nanosecond timestamp both times, with the assistant confidently presenting it
// as this run's real output. The cache's whole point is that an identical (command, cwd) pair is
// expected to produce the same result again (a status check, a file listing, ...) — that
// assumption is false by construction for a command whose entire purpose is to vary each time, so
// those commands should always re-stage a fresh approval instead of ever serving a cached answer.
// Deliberately narrow (clock/randomness sources only, not e.g. "df"/"ps" whose output can also
// drift): those are the two big deterministic-in-principle nondeterminism sources, and getting
// this list exactly exhaustive isn't the goal — a false positive here just costs one extra
// approval prompt on a genuine repeat, the same tradeoff this cache already accepts elsewhere.
const NONDETERMINISTIC_COMMAND_PATTERN = /\b(date|time|now)\b|\$RANDOM\b|\/dev\/u?random\b|\buuidgen\b|\bopenssl rand\b/i

function isCacheableCommand(command: string): boolean {
  return !NONDETERMINISTIC_COMMAND_PATTERN.test(command)
}

export async function loadShellCache(backend: FsBackend, workspaceRoot: string): Promise<ShellCacheEntry[]> {
  const raw = await backend.readTextFile(shellCachePath(workspaceRoot))
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ShellCacheEntry[]) : []
  } catch {
    return []
  }
}

export async function recordShellCacheEntry(backend: FsBackend, workspaceRoot: string, entry: ShellCacheEntry): Promise<void> {
  const existing = await loadShellCache(backend, workspaceRoot)
  await backend.mkdir(`${workspaceRoot}/${SHELL_CACHE_DIR}`)
  await backend.writeTextFile(shellCachePath(workspaceRoot), JSON.stringify([...existing, entry]))
}

/** Most-recent match wins — a command could plausibly be re-approved deliberately later in the
 * same session (e.g. a live status check), so the latest resolution is the right one to serve. */
export async function findCachedShellResult(
  backend: FsBackend,
  workspaceRoot: string,
  command: string,
  cwd: string,
): Promise<ShellCacheEntry | undefined> {
  if (!isCacheableCommand(command)) return undefined
  const entries = await loadShellCache(backend, workspaceRoot)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].command === command && entries[i].cwd === cwd) return entries[i]
  }
  return undefined
}

export async function clearShellCache(backend: FsBackend, workspaceRoot: string): Promise<void> {
  await backend.removeFile(shellCachePath(workspaceRoot))
}
