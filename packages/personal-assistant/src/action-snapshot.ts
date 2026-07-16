import type { FsBackend } from '@buildaharness/runtime'

/**
 * FsBackend's I/O is UTF-8 text only (readTextFile/writeTextFile). Reading a binary file (an
 * image, a compiled artifact) through it and later writing the decoded string back is a lossy
 * round-trip: invalid byte sequences decode to U+FFFD, and the original bytes are gone for good
 * once that gets written back on revert. A real UTF-8 text file won't naturally contain U+FFFD,
 * so its presence is a reliable-enough signal that the content isn't safe to capture this way.
 */
const REPLACEMENT_CHAR = '�'

function looksBinary(content: string): boolean {
  return content.includes(REPLACEMENT_CHAR)
}

// T3 will add a 'revert'-kind variant (one-shot, never itself logged) to this union — out of
// scope here.
export type UndoLogEntry =
  | {
      id: string
      appliedActionId: string
      kind: 'write'
      path: string
      previousContent: string | null
      appliedAt: string
      undoable: true
    }
  | {
      id: string
      appliedActionId: string
      kind: 'write'
      path: string
      appliedAt: string
      undoable: false
      reason: string
    }
  | {
      id: string
      appliedActionId: string
      kind: 'shell'
      command: string
      appliedAt: string
      undoable: true
      added: string[]
      modified: { path: string; previousContent: string }[]
      deleted: { path: string; previousContent: string }[]
      // Paths the diff saw change but couldn't capture (excluded dir, binary, oversized) —
      // surfaced so a revert says "incomplete" instead of looking whole. Non-empty here still
      // means undoable: true for the paths that WERE captured; see buildShellUndoLogEntry's doc
      // comment for why only a truncated tree walk (the ceiling), not this, escalates to false.
      unsnapshottableChanges: string[]
    }
  | {
      id: string
      appliedActionId: string
      kind: 'shell'
      command: string
      appliedAt: string
      undoable: false
      reason: string
    }

export type SnapshotBeforeWriteResult =
  | { previousContent: string | null; undoable: true }
  | { previousContent?: undefined; undoable: false; reason: string }

/**
 * Reads a write_file target's current content before it gets overwritten, so an undo-log entry
 * can later restore it. `path` must already be resolved/verified against the workspace root by
 * the caller (file-tools.ts's applyPendingAction) — this does no path validation of its own.
 * `workspaceRoot` is accepted for signature parity with T2's snapshotWorkspaceTree, which does
 * need it for a recursive walk; a single-file read has no use for it.
 *
 * A read error other than "file doesn't exist" (FsBackend.readTextFile resolves `undefined` only
 * for that case) is intentionally left to propagate rather than caught here, so a genuine I/O
 * failure surfaces as a failed approval instead of silently producing a wrong/empty snapshot.
 */
export async function snapshotBeforeWrite(
  backend: FsBackend,
  workspaceRoot: string,
  path: string,
): Promise<SnapshotBeforeWriteResult> {
  void workspaceRoot
  const existing = await backend.readTextFile(path)
  if (existing === undefined) return { previousContent: null, undoable: true }
  if (looksBinary(existing)) {
    return { undoable: false, reason: 'existing file is binary, cannot capture its prior content' }
  }
  return { previousContent: existing, undoable: true }
}

const UNDO_LOG_DIR = '.undo-log'

/** One shared cap across every entry kind (write, and later shell/revert) — not a per-kind cap. */
export const UNDO_LOG_MAX_ENTRIES = 20

function undoLogDir(workspaceRoot: string): string {
  return `${workspaceRoot}/${UNDO_LOG_DIR}`
}

function undoLogPath(workspaceRoot: string, id: string): string {
  return `${undoLogDir(workspaceRoot)}/${id}.json`
}

/**
 * Persists an undo-log entry, then prunes the oldest entries once UNDO_LOG_MAX_ENTRIES is
 * exceeded — mirrors the "cap it, don't let it grow forever" convention already used elsewhere
 * in this package (e.g. the batch-budget plan's ABSOLUTE_TURN_CEILING).
 */
export async function recordUndoLogEntry(backend: FsBackend, workspaceRoot: string, entry: UndoLogEntry): Promise<void> {
  await backend.mkdir(undoLogDir(workspaceRoot))
  await backend.writeTextFile(undoLogPath(workspaceRoot, entry.id), JSON.stringify(entry))
  await pruneUndoLog(backend, workspaceRoot)
}

export async function loadUndoLogEntry(backend: FsBackend, workspaceRoot: string, id: string): Promise<UndoLogEntry | undefined> {
  const raw = await backend.readTextFile(undoLogPath(workspaceRoot, id))
  return raw === undefined ? undefined : (JSON.parse(raw) as UndoLogEntry)
}

/** Newest first (by appliedAt) — feeds /undo-action's no-argument listing view (T3). */
export async function listUndoLogEntries(backend: FsBackend, workspaceRoot: string): Promise<UndoLogEntry[]> {
  const names = await backend.readDir(undoLogDir(workspaceRoot))
  const entries: UndoLogEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await backend.readTextFile(`${undoLogDir(workspaceRoot)}/${name}`)
    if (raw === undefined) continue
    try {
      entries.push(JSON.parse(raw) as UndoLogEntry)
    } catch {
      // A corrupted entry shouldn't take down the whole listing — skip it.
    }
  }
  entries.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
  return entries
}

export async function deleteUndoLogEntry(backend: FsBackend, workspaceRoot: string, id: string): Promise<void> {
  await backend.removeFile(undoLogPath(workspaceRoot, id))
}

async function pruneUndoLog(backend: FsBackend, workspaceRoot: string): Promise<void> {
  const entries = await listUndoLogEntries(backend, workspaceRoot) // newest first
  if (entries.length <= UNDO_LOG_MAX_ENTRIES) return
  const oldest = entries.slice(UNDO_LOG_MAX_ENTRIES)
  for (const entry of oldest) {
    await deleteUndoLogEntry(backend, workspaceRoot, entry.id)
  }
}

// ── Workspace-wide snapshot + diff for run_shell_command (T2) ──────────────────────────

/** Per-file cap — a file over this size is reported as skipped, never partially captured. */
export const UNDO_SNAPSHOT_MAX_FILE_BYTES = 1_000_000

/** Overall file-count ceiling for one walk — hitting it truncates the whole snapshot (see
 * WorkspaceSnapshot.truncated), not just the files past the ceiling, since a walk that stops
 * partway through gives no reliable picture of "everything else is unchanged" either. */
export const UNDO_SNAPSHOT_MAX_FILES = 2000

/**
 * Directory names skipped by default during a workspace walk — this feature's own bookkeeping
 * plus conventionally-heavy, rarely-hand-edited directories. Without this, a walk would blow
 * UNDO_SNAPSHOT_MAX_FILES on node_modules/ alone for any real npm-monorepo workspace.
 */
export const UNDO_SNAPSHOT_EXCLUDED_DIRS = [
  '.pending-actions',
  '.undo-log',
  '.shell-cache',
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'venv',
  '__pycache__',
]

export interface WorkspaceSnapshot {
  files: Map<string, string>
  skipped: { path: string; reason: string; size?: number }[]
  truncated: boolean
  truncationReason?: string
  /**
   * Deviation from the plan's summary interface (which lists only files/skipped/truncated/
   * truncationReason): a cheap, non-recursive immediate-child-name listing taken once per
   * excluded directory encountered, keyed by that directory's path. Excluded directories are
   * never walked into (that's the whole point — see UNDO_SNAPSHOT_EXCLUDED_DIRS's doc comment),
   * so there is no per-file record of their contents to diff. This one-level signature is the
   * cheapest available signal that lets diffSnapshots notice "something was added to or removed
   * from node_modules/ directly" without paying to walk its full subtree. It's necessarily
   * best-effort — a content-only change to a file already inside an excluded directory, or a
   * change nested more than one level deep inside it, isn't detected by this signature alone.
   */
  excludedDirSignatures: Map<string, string>
}

function gitignoreLineToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * Best-effort, line-based only — not a full gitignore-spec implementation (no negation, no
 * directory-only `/` trailing-slash distinction, no path-anchored `/leading/slash` patterns).
 * Matched against a bare file/directory *name*, not a full relative path, which is enough to
 * extend a project's own "don't track this" boundary to "don't snapshot this either" for the
 * common case (a name or glob per line) without building a real gitignore matcher.
 */
function parseGitignore(content: string): RegExp[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((line) => line.length > 0)
    .map(gitignoreLineToRegex)
}

function matchesGitignore(name: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name))
}

interface WalkState {
  snapshot: WorkspaceSnapshot
  gitignorePatterns: RegExp[]
  fileCount: number
}

async function walk(backend: FsBackend, dir: string, state: WalkState): Promise<void> {
  if (state.snapshot.truncated) return
  const names = await backend.readDir(dir)
  for (const name of names) {
    if (state.snapshot.truncated) return
    const path = `${dir}/${name}`
    let info: { isDirectory: boolean; size: number } | undefined
    try {
      // backend.stat is asserted present by the caller (snapshotWorkspaceTree bails out before
      // ever calling walk() if it's missing) — the non-null assertion here just avoids repeating
      // that check on every recursion.
      info = await backend.stat!(path)
    } catch {
      // A stat failure mid-walk (permissions, a race with something else touching the tree)
      // must not take down the whole shell command — same "never a reason an approved action
      // silently fails" guardrail as the ceiling/size caps below. Record and move on.
      state.snapshot.skipped.push({ path, reason: 'could not stat this path' })
      continue
    }
    if (info === undefined) continue // vanished between readDir and stat — nothing to capture

    if (info.isDirectory) {
      const isExcludedByName = UNDO_SNAPSHOT_EXCLUDED_DIRS.includes(name)
      const isExcludedByGitignore = matchesGitignore(name, state.gitignorePatterns)
      if (isExcludedByName || isExcludedByGitignore) {
        const children = await backend.readDir(path)
        state.snapshot.excludedDirSignatures.set(path, [...children].sort().join('\n'))
        state.snapshot.skipped.push({
          path,
          reason: isExcludedByName ? `inside default-excluded directory "${name}"` : 'directory matches .gitignore',
        })
        continue
      }
      await walk(backend, path, state)
      continue
    }

    if (state.fileCount >= UNDO_SNAPSHOT_MAX_FILES) {
      state.snapshot.truncated = true
      state.snapshot.truncationReason = `workspace has more than ${UNDO_SNAPSHOT_MAX_FILES} files, too large to snapshot fully`
      return
    }
    state.fileCount++

    if (matchesGitignore(name, state.gitignorePatterns)) {
      state.snapshot.skipped.push({ path, reason: 'matches .gitignore', size: info.size })
      continue
    }
    if (info.size > UNDO_SNAPSHOT_MAX_FILE_BYTES) {
      state.snapshot.skipped.push({ path, reason: `exceeds the ${UNDO_SNAPSHOT_MAX_FILE_BYTES}-byte snapshot size cap`, size: info.size })
      continue
    }

    let content: string | undefined
    try {
      content = await backend.readTextFile(path)
    } catch {
      state.snapshot.skipped.push({ path, reason: 'could not read this file', size: info.size })
      continue
    }
    if (content === undefined) continue // vanished between stat and read
    if (looksBinary(content)) {
      state.snapshot.skipped.push({ path, reason: 'binary file, cannot capture safely', size: info.size })
      continue
    }
    state.snapshot.files.set(path, content)
  }
}

/**
 * Recursively snapshots every text file under `workspaceRoot`, for diffing before/after a
 * run_shell_command execution (T2 step 6) since a shell command has no single known target path
 * the way write_file does. Skips default-excluded directories, oversized files, and binary
 * files (see the exported constants above) rather than either blowing past a sane cost ceiling
 * or silently corrupting a binary file via a lossy UTF-8 round-trip.
 *
 * Requires `backend.stat` (optional on FsBackend — only backends doing a recursive walk need
 * it). A backend without it can't distinguish a file from a directory, so this returns
 * immediately with `truncated: true` rather than attempting an unreliable walk.
 */
export async function snapshotWorkspaceTree(backend: FsBackend, workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { files: new Map(), skipped: [], truncated: false, excludedDirSignatures: new Map() }
  if (!backend.stat) {
    return { ...snapshot, truncated: true, truncationReason: 'this backend does not support recursive directory snapshotting' }
  }

  let gitignorePatterns: RegExp[] = []
  try {
    const gitignoreRaw = await backend.readTextFile(`${workspaceRoot}/.gitignore`)
    if (gitignoreRaw !== undefined) gitignorePatterns = parseGitignore(gitignoreRaw)
  } catch {
    // Best-effort only (see parseGitignore's doc comment) — an unreadable .gitignore just means
    // no extra patterns, not a reason to fail the whole snapshot.
  }

  await walk(backend, workspaceRoot, { snapshot, gitignorePatterns, fileCount: 0 })
  return snapshot
}

export interface WorkspaceDiff {
  added: string[]
  modified: { path: string; previousContent: string }[]
  deleted: { path: string; previousContent: string }[]
  unsnapshottableChanges: string[]
}

/**
 * Diffs two workspace snapshots taken before/after a shell command ran. Only the actual diff is
 * meant to be persisted to an undo-log entry, not two full tree copies.
 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
  const added: string[] = []
  const modified: { path: string; previousContent: string }[] = []
  const deleted: { path: string; previousContent: string }[] = []
  const unsnapshottableChanges = new Set<string>()

  for (const [path, afterContent] of after.files) {
    const beforeContent = before.files.get(path)
    if (beforeContent === undefined) {
      // A path that was skipped (not captured) before but is a plain captured file now has no
      // known prior content to revert to — flag it rather than claiming it's simply "new".
      if (before.skipped.some((s) => s.path === path)) unsnapshottableChanges.add(path)
      else added.push(path)
    } else if (beforeContent !== afterContent) {
      modified.push({ path, previousContent: beforeContent })
    }
  }

  for (const [path, beforeContent] of before.files) {
    if (after.files.has(path)) continue
    // Still present but no longer capturable (grew past the size cap, turned binary) — the
    // prior content is still known, so this is a recoverable "modified", not a loss.
    if (after.skipped.some((s) => s.path === path)) modified.push({ path, previousContent: beforeContent })
    else deleted.push({ path, previousContent: beforeContent })
  }

  const beforeSkippedByPath = new Map(before.skipped.map((s) => [s.path, s]))
  const afterSkippedByPath = new Map(after.skipped.map((s) => [s.path, s]))
  for (const [path, afterSkip] of afterSkippedByPath) {
    const beforeSkip = beforeSkippedByPath.get(path)
    if (!beforeSkip || beforeSkip.size !== afterSkip.size) unsnapshottableChanges.add(path)
  }
  for (const [path] of beforeSkippedByPath) {
    if (!afterSkippedByPath.has(path) && !after.files.has(path)) unsnapshottableChanges.add(path)
  }

  for (const [dirPath, afterSignature] of after.excludedDirSignatures) {
    if (before.excludedDirSignatures.get(dirPath) !== afterSignature) unsnapshottableChanges.add(dirPath)
  }

  return { added, modified, deleted, unsnapshottableChanges: [...unsnapshottableChanges] }
}

/**
 * Builds the undo-log entry for a completed run_shell_command approval from its before/after
 * workspace snapshots (T2 step 7).
 *
 * Deviation / judgment call: step 7's prose says a non-empty `unsnapshottableChanges` escalates
 * the whole entry to `undoable: false`, but the Files tab's own type-level doc comment on the
 * `undoable: true` shell variant says the opposite ("non-empty here still means undoable: true
 * for the paths that WERE captured"), and the Test Plan tab's cases for node_modules-only and
 * binary-file changes describe the command "executing normally" with the change merely
 * "reported in unsnapshottableChanges" — neither test expects undoable: false for those cases.
 * Following the type comment and the Test Plan tab (the more precise, mutually-consistent
 * sources) over the summary prose: only a *truncated* tree walk — meaning the before/after
 * picture itself is unreliable, not just a subset of paths within it — escalates to
 * `undoable: false`. A non-empty `unsnapshottableChanges` on an otherwise-complete walk keeps
 * `undoable: true`, offering a partial revert for the paths that were captured, with the
 * incompleteness surfaced on the entry for a later /undo-action to warn about (T3).
 */
export function buildShellUndoLogEntry(
  appliedActionId: string,
  command: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): UndoLogEntry {
  const base = {
    id: crypto.randomUUID(),
    appliedActionId,
    kind: 'shell' as const,
    command,
    appliedAt: new Date().toISOString(),
  }
  if (before.truncated || after.truncated) {
    return {
      ...base,
      undoable: false,
      reason: before.truncationReason ?? after.truncationReason ?? 'workspace too large to snapshot',
    }
  }
  const diff = diffSnapshots(before, after)
  return { ...base, undoable: true, ...diff }
}

// ── Revert plan (T3) ────────────────────────────────────────────────────────────────────

/**
 * The concrete filesystem operations a revert needs to perform, derived from one undo-log
 * entry: every path in `restore` gets its `content` written back; every path in `remove` gets
 * deleted (it didn't exist, or wasn't created, before the original action ran). Kept as its own
 * plain-data shape (rather than handing the raw UndoLogEntry to applyPendingAction) so the
 * staged `kind: 'revert'` PendingActionPayload carries exactly what it needs to apply, the same
 * way `kind: 'write'`/`kind: 'shell'` already carry their own complete, self-sufficient payload.
 */
export interface RevertPlan {
  restore: { path: string; content: string }[]
  remove: string[]
}

/** `undefined` when `entry.undoable` is false — an undoable:false entry has nothing to revert. */
export function buildRevertPlan(entry: UndoLogEntry): RevertPlan | undefined {
  if (!entry.undoable) return undefined
  if (entry.kind === 'write') {
    if (entry.previousContent === null) return { restore: [], remove: [entry.path] }
    return { restore: [{ path: entry.path, content: entry.previousContent }], remove: [] }
  }
  return {
    restore: [...entry.modified, ...entry.deleted].map((e) => ({ path: e.path, content: e.previousContent })),
    remove: [...entry.added],
  }
}
