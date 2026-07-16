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

// T2 will add a 'shell'-kind variant (workspace-wide diff) and T3 a 'revert'-kind variant
// (one-shot, never itself logged) to this union — out of scope for T1.
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
